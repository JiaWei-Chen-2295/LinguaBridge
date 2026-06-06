use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

use super::error::{AudioCaptureError, AudioCaptureErrorKind};
use super::types::{
    AudioCaptureCapabilities, AudioCaptureCapabilityReason, AudioCaptureConfig, AudioCaptureMode,
    AudioCaptureStatus, AudioCaptureStatusKind, AudioDevice, AudioDeviceKind, AudioDeviceStatus,
    AudioFramePayload, AudioLoopbackCapability, ProcessExcludeLoopbackCapability,
    AUDIO_CAPTURE_STATUS_EVENT, AUDIO_FRAME_EVENT,
};

#[cfg(windows)]
use windows::{
    core::{implement, Interface, BSTR, GUID, HRESULT, PCWSTR, PROPVARIANT},
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Foundation::CloseHandle,
        Media::{
            Audio::{
                eConsole, eRender, ActivateAudioInterfaceAsync,
                IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
                IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
                IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
                AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
                AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
                DEVICE_STATE_ACTIVE, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
                WAVE_FORMAT_PCM,
            },
            KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CoTaskMemFree, CoUninitialize,
            CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
        },
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        System::Threading::GetCurrentProcessId,
    },
};

#[cfg(windows)]
const WAVE_FORMAT_EXTENSIBLE_TAG: u32 = 0xFFFE;

#[cfg(windows)]
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_GUID: GUID =
    GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

#[cfg(windows)]
const PROCESS_EXCLUDE_LOOPBACK_MINIMUM_BUILD: u32 = 20_348;

#[cfg(windows)]
const PROCESS_LOOPBACK_CAPTURE_SAMPLE_RATE_HZ: u32 = 44_100;

#[cfg(windows)]
const PROCESS_LOOPBACK_CAPTURE_CHANNELS: u16 = 2;

#[cfg(windows)]
const PROCESS_LOOPBACK_CAPTURE_BITS_PER_SAMPLE: u16 = 16;

#[cfg(windows)]
const VT_BLOB: u16 = 65;

#[cfg(windows)]
struct CaptureThread {
    stop: Arc<AtomicBool>,
    join: JoinHandle<Result<(), AudioCaptureError>>,
}

#[cfg(windows)]
#[derive(Clone)]
struct ProcessSnapshotEntry {
    process_id: u32,
    parent_process_id: u32,
    exe_file: String,
}

#[cfg(windows)]
static CAPTURE_THREAD: OnceLock<Mutex<Option<CaptureThread>>> = OnceLock::new();

pub struct CaptureStartInfo {
    pub device_id: String,
    pub started_at_ms: u64,
}

#[cfg(windows)]
pub fn get_audio_capture_capabilities() -> AudioCaptureCapabilities {
    let windows_build = windows_build_number();
    let process_exclude_loopback = match windows_build {
        Some(build) if build >= PROCESS_EXCLUDE_LOOPBACK_MINIMUM_BUILD => {
            if process_exclude_loopback_activation_supported() {
                ProcessExcludeLoopbackCapability {
                    supported: true,
                    reason: None,
                    minimum_build: PROCESS_EXCLUDE_LOOPBACK_MINIMUM_BUILD,
                    current_build: Some(build),
                }
            } else {
                ProcessExcludeLoopbackCapability {
                    supported: false,
                    reason: Some(AudioCaptureCapabilityReason::ActivationFailed),
                    minimum_build: PROCESS_EXCLUDE_LOOPBACK_MINIMUM_BUILD,
                    current_build: Some(build),
                }
            }
        }
        Some(build) => ProcessExcludeLoopbackCapability {
            supported: false,
            reason: Some(AudioCaptureCapabilityReason::UnsupportedOs),
            minimum_build: PROCESS_EXCLUDE_LOOPBACK_MINIMUM_BUILD,
            current_build: Some(build),
        },
        None => ProcessExcludeLoopbackCapability {
            supported: false,
            reason: Some(AudioCaptureCapabilityReason::UnsupportedOs),
            minimum_build: PROCESS_EXCLUDE_LOOPBACK_MINIMUM_BUILD,
            current_build: None,
        },
    };

    AudioCaptureCapabilities {
        endpoint_loopback: AudioLoopbackCapability {
            supported: true,
            reason: None,
        },
        process_exclude_loopback,
        windows_build,
    }
}

#[cfg(not(windows))]
pub fn get_audio_capture_capabilities() -> AudioCaptureCapabilities {
    AudioCaptureCapabilities {
        endpoint_loopback: AudioLoopbackCapability {
            supported: false,
            reason: Some(AudioCaptureCapabilityReason::NotWindows),
        },
        process_exclude_loopback: ProcessExcludeLoopbackCapability {
            supported: false,
            reason: Some(AudioCaptureCapabilityReason::NotWindows),
            minimum_build: 20_348,
            current_build: None,
        },
        windows_build: None,
    }
}

#[cfg(windows)]
pub fn list_loopback_devices() -> Result<Vec<AudioDevice>, AudioCaptureError> {
    match thread::spawn(list_loopback_devices_on_thread).join() {
        Ok(result) => result,
        Err(_) => Err(AudioCaptureError::new(
            AudioCaptureErrorKind::Internal,
            "WASAPI device enumeration thread panicked.",
            true,
        )),
    }
}

#[cfg(windows)]
fn list_loopback_devices_on_thread() -> Result<Vec<AudioDevice>, AudioCaptureError> {
    let _com = ComApartment::initialize()?;
    let enumerator = create_device_enumerator()?;
    let default_device_id = default_output_device_id(&enumerator)?;
    let collection = unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }
        .map_err(|error| windows_error(AudioCaptureErrorKind::DeviceUnavailable, error))?;
    let device_count = unsafe { collection.GetCount() }
        .map_err(|error| windows_error(AudioCaptureErrorKind::DeviceUnavailable, error))?;
    let mut devices = Vec::with_capacity(device_count as usize);

    for index in 0..device_count {
        let device = unsafe { collection.Item(index) }
            .map_err(|error| windows_error(AudioCaptureErrorKind::DeviceUnavailable, error))?;
        let id = device_id(&device)?;
        let name = device_name(&device).unwrap_or_else(|| format!("Windows output {}", index + 1));
        let (sample_rate_hz, channels) = device_mix_format(&device).unwrap_or((None, None));

        devices.push(AudioDevice {
            id: id.clone(),
            name,
            kind: AudioDeviceKind::LoopbackOutput,
            status: AudioDeviceStatus::Available,
            is_default: id == default_device_id,
            sample_rate_hz,
            channels,
        });
    }

    if devices.is_empty() {
        return Err(AudioCaptureError::new(
            AudioCaptureErrorKind::DeviceUnavailable,
            "No active Windows output devices are available for WASAPI loopback.",
            true,
        ));
    }

    Ok(devices)
}

#[cfg(not(windows))]
pub fn list_loopback_devices() -> Result<Vec<AudioDevice>, AudioCaptureError> {
    Err(AudioCaptureError::new(
        AudioCaptureErrorKind::UnsupportedPlatform,
        "LinguaBridge MVP audio capture is scoped to Windows 10/11 WASAPI loopback.",
        false,
    ))
}

#[cfg(windows)]
pub fn start_loopback_capture(
    config: &AudioCaptureConfig,
    app: AppHandle,
) -> Result<CaptureStartInfo, AudioCaptureError> {
    if config.sample_rate_hz != 16_000 || config.channels != 1 {
        return Err(AudioCaptureError::new(
            AudioCaptureErrorKind::SampleRateConversionFailed,
            "The MVP capture pipeline currently outputs only 16 kHz mono PCM16 frames.",
            true,
        ));
    }

    let slot = CAPTURE_THREAD.get_or_init(|| Mutex::new(None));
    let mut guard = slot.lock().map_err(|_| {
        AudioCaptureError::new(
            AudioCaptureErrorKind::Internal,
            "WASAPI capture lock is poisoned.",
            true,
        )
    })?;

    if guard.is_some() {
        return Err(AudioCaptureError::already_capturing());
    }

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread_config = config.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let join = thread::spawn(move || run_capture_thread(thread_config, app, thread_stop, ready_tx));

    match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(start_info)) => {
            *guard = Some(CaptureThread { stop, join });
            Ok(start_info)
        }
        Ok(Err(error)) => {
            let _ = join.join();
            Err(error)
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            let _ = join.join();
            Err(AudioCaptureError::new(
                AudioCaptureErrorKind::WasapiUnavailable,
                "WASAPI loopback did not become ready within 3 seconds.",
                true,
            ))
        }
    }
}

#[cfg(not(windows))]
pub fn start_loopback_capture(
    _config: &AudioCaptureConfig,
    _app: AppHandle,
) -> Result<CaptureStartInfo, AudioCaptureError> {
    Err(AudioCaptureError::new(
        AudioCaptureErrorKind::UnsupportedPlatform,
        "LinguaBridge MVP audio capture can only start on Windows 10/11.",
        false,
    ))
}

#[cfg(windows)]
pub fn stop_loopback_capture() -> Result<(), AudioCaptureError> {
    let slot = CAPTURE_THREAD.get_or_init(|| Mutex::new(None));
    let mut guard = slot.lock().map_err(|_| {
        AudioCaptureError::new(
            AudioCaptureErrorKind::Internal,
            "WASAPI capture lock is poisoned.",
            true,
        )
    })?;

    let Some(capture_thread) = guard.take() else {
        return Ok(());
    };

    capture_thread.stop.store(true, Ordering::SeqCst);
    match capture_thread.join.join() {
        Ok(result) => result,
        Err(_) => Err(AudioCaptureError::new(
            AudioCaptureErrorKind::Internal,
            "WASAPI capture thread panicked while stopping.",
            true,
        )),
    }
}

#[cfg(not(windows))]
pub fn stop_loopback_capture() -> Result<(), AudioCaptureError> {
    Ok(())
}

#[cfg(windows)]
pub fn take_finished_loopback_capture(
) -> Result<Option<Result<(), AudioCaptureError>>, AudioCaptureError> {
    let slot = CAPTURE_THREAD.get_or_init(|| Mutex::new(None));
    let mut guard = slot.lock().map_err(|_| {
        AudioCaptureError::new(
            AudioCaptureErrorKind::Internal,
            "WASAPI capture lock is poisoned.",
            true,
        )
    })?;

    let Some(capture_thread) = guard.as_ref() else {
        return Ok(None);
    };

    if !capture_thread.join.is_finished() {
        return Ok(None);
    }

    let Some(capture_thread) = guard.take() else {
        return Ok(None);
    };

    capture_thread.stop.store(true, Ordering::SeqCst);
    let result = match capture_thread.join.join() {
        Ok(result) => result,
        Err(_) => Err(AudioCaptureError::new(
            AudioCaptureErrorKind::Internal,
            "WASAPI capture thread panicked.",
            true,
        )),
    };

    Ok(Some(result))
}

#[cfg(not(windows))]
pub fn take_finished_loopback_capture(
) -> Result<Option<Result<(), AudioCaptureError>>, AudioCaptureError> {
    Ok(None)
}

#[cfg(windows)]
fn run_capture_thread(
    config: AudioCaptureConfig,
    app: AppHandle,
    stop: Arc<AtomicBool>,
    ready_tx: std::sync::mpsc::Sender<Result<CaptureStartInfo, AudioCaptureError>>,
) -> Result<(), AudioCaptureError> {
    let result = run_capture_loop(config, app, stop, &ready_tx);
    if let Err(error) = &result {
        let _ = ready_tx.send(Err(error.clone()));
    }
    result
}

#[cfg(windows)]
fn run_capture_loop(
    config: AudioCaptureConfig,
    app: AppHandle,
    stop: Arc<AtomicBool>,
    ready_tx: &std::sync::mpsc::Sender<Result<CaptureStartInfo, AudioCaptureError>>,
) -> Result<(), AudioCaptureError> {
    match config.mode {
        AudioCaptureMode::EndpointLoopback => {
            run_endpoint_capture_loop(config, app, stop, ready_tx)
        }
        AudioCaptureMode::ProcessExcludeLoopback => {
            run_process_exclude_capture_loop(config, app, stop, ready_tx)
        }
    }
}

#[cfg(windows)]
fn run_endpoint_capture_loop(
    config: AudioCaptureConfig,
    app: AppHandle,
    stop: Arc<AtomicBool>,
    ready_tx: &std::sync::mpsc::Sender<Result<CaptureStartInfo, AudioCaptureError>>,
) -> Result<(), AudioCaptureError> {
    let _com = ComApartment::initialize()?;
    let enumerator = create_device_enumerator()?;
    let default_device_id = default_output_device_id(&enumerator)?;
    let device = resolve_loopback_device(&enumerator, config.device_id.as_deref())?;
    let active_device_id = device_id(&device)?;
    let follows_default_output = active_device_id == default_device_id;
    let audio_client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
        .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    let mix_format_ptr = unsafe { audio_client.GetMixFormat() }
        .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    let mix_format = unsafe { read_mix_format(mix_format_ptr)? };

    unsafe {
        audio_client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                1_000_000,
                0,
                mix_format_ptr,
                None,
            )
            .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
        CoTaskMemFree(Some(mix_format_ptr.cast()));
    }

    let capture_client: IAudioCaptureClient = unsafe { audio_client.GetService() }
        .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    let mut emitter = FrameEmitter::new(config.clone(), mix_format.sample_rate, app.clone());

    unsafe {
        audio_client
            .Start()
            .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    }
    let started_at_ms = now_ms();
    let mut default_output_tracker =
        follows_default_output.then(|| DefaultOutputDeviceTracker::new(active_device_id.clone()));
    let _ = ready_tx.send(Ok(CaptureStartInfo {
        device_id: active_device_id.clone(),
        started_at_ms,
    }));

    let capture_result = pump_capture_packets(
        &enumerator,
        &capture_client,
        &mix_format,
        &mut emitter,
        default_output_tracker.as_mut(),
        &stop,
    );

    unsafe {
        let _ = audio_client.Stop();
    }

    if let Err(error) = &capture_result {
        emit_capture_status_error(&app, &config, &active_device_id, started_at_ms, error);
    }

    capture_result
}

#[cfg(windows)]
fn run_process_exclude_capture_loop(
    config: AudioCaptureConfig,
    app: AppHandle,
    stop: Arc<AtomicBool>,
    ready_tx: &std::sync::mpsc::Sender<Result<CaptureStartInfo, AudioCaptureError>>,
) -> Result<(), AudioCaptureError> {
    let _com = ComApartment::initialize()?;
    let current_build = windows_build_number();
    if !matches!(current_build, Some(build) if build >= PROCESS_EXCLUDE_LOOPBACK_MINIMUM_BUILD) {
        return Err(AudioCaptureError::new(
            AudioCaptureErrorKind::WasapiUnavailable,
            "Windows process-exclude loopback requires Windows 10 Build 20348 or newer.",
            true,
        ));
    }

    let enumerator = create_device_enumerator()?;
    let current_process_id = unsafe { GetCurrentProcessId() };
    let target_process_id = process_loopback_exclusion_target(current_process_id);
    let active_device_id =
        format!("process-exclude-loopback:{target_process_id}:owner:{current_process_id}");
    let audio_client = activate_process_exclude_audio_client(target_process_id)?;
    let (wave_format, mix_format, stream_flags) = process_loopback_capture_format_and_flags();

    unsafe {
        audio_client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags,
                1_000_000,
                0,
                &wave_format,
                None,
            )
            .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    }

    let capture_client: IAudioCaptureClient = unsafe { audio_client.GetService() }
        .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    let mut emitter = FrameEmitter::new(config.clone(), mix_format.sample_rate, app.clone());

    unsafe {
        audio_client
            .Start()
            .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    }
    let started_at_ms = now_ms();
    let _ = ready_tx.send(Ok(CaptureStartInfo {
        device_id: active_device_id.clone(),
        started_at_ms,
    }));

    let capture_result = pump_capture_packets(
        &enumerator,
        &capture_client,
        &mix_format,
        &mut emitter,
        None,
        &stop,
    );

    unsafe {
        let _ = audio_client.Stop();
    }

    if let Err(error) = &capture_result {
        emit_capture_status_error(&app, &config, &active_device_id, started_at_ms, error);
    }

    capture_result
}

#[cfg(windows)]
fn pump_capture_packets(
    enumerator: &IMMDeviceEnumerator,
    capture_client: &IAudioCaptureClient,
    mix_format: &MixFormat,
    emitter: &mut FrameEmitter,
    mut default_output_tracker: Option<&mut DefaultOutputDeviceTracker>,
    stop: &AtomicBool,
) -> Result<(), AudioCaptureError> {
    while !stop.load(Ordering::SeqCst) {
        if let Some(tracker) = default_output_tracker.as_deref_mut() {
            tracker.check(enumerator)?;
        }

        let mut packet_size = unsafe { capture_client.GetNextPacketSize() }
            .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;

        if packet_size == 0 {
            thread::sleep(Duration::from_millis(5));
            continue;
        }

        while packet_size > 0 && !stop.load(Ordering::SeqCst) {
            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut frames_to_read = 0_u32;
            let mut flags = 0_u32;
            unsafe {
                capture_client
                    .GetBuffer(&mut data_ptr, &mut frames_to_read, &mut flags, None, None)
                    .map_err(|error| {
                        windows_error(AudioCaptureErrorKind::WasapiUnavailable, error)
                    })?;
            }

            let conversion = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                Ok(vec![0.0; frames_to_read as usize])
            } else {
                unsafe { convert_packet_to_mono(data_ptr, frames_to_read, &mix_format) }
            };

            unsafe {
                capture_client
                    .ReleaseBuffer(frames_to_read)
                    .map_err(|error| {
                        windows_error(AudioCaptureErrorKind::WasapiUnavailable, error)
                    })?;
            }

            emitter.push_samples(conversion?)?;
            packet_size = unsafe { capture_client.GetNextPacketSize() }
                .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
        }
    }

    Ok(())
}

#[cfg(windows)]
fn create_device_enumerator() -> Result<IMMDeviceEnumerator, AudioCaptureError> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
        .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))
}

#[cfg(windows)]
fn probe_process_exclude_loopback_activation() -> Result<(), AudioCaptureError> {
    let _com = ComApartment::initialize()?;
    let current_process_id = unsafe { GetCurrentProcessId() };
    let audio_client = activate_process_exclude_audio_client(current_process_id)?;
    drop(audio_client);
    Ok(())
}

#[cfg(windows)]
fn process_exclude_loopback_activation_supported() -> bool {
    matches!(
        thread::spawn(probe_process_exclude_loopback_activation).join(),
        Ok(Ok(()))
    )
}

#[cfg(windows)]
fn process_loopback_exclusion_target(current_process_id: u32) -> u32 {
    match process_snapshot_entries() {
        Ok(entries) => select_process_loopback_exclusion_target(current_process_id, &entries),
        Err(_) => current_process_id,
    }
}

#[cfg(windows)]
fn select_process_loopback_exclusion_target(
    current_process_id: u32,
    entries: &[ProcessSnapshotEntry],
) -> u32 {
    entries
        .iter()
        .find(|entry| {
            entry.parent_process_id == current_process_id
                && entry.exe_file.eq_ignore_ascii_case("msedgewebview2.exe")
        })
        .map(|entry| entry.process_id)
        .unwrap_or(current_process_id)
}

#[cfg(windows)]
fn process_snapshot_entries() -> Result<Vec<ProcessSnapshotEntry>, AudioCaptureError> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..PROCESSENTRY32W::default()
    };
    let mut entries = Vec::new();

    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry).is_ok() };
    while has_entry {
        entries.push(ProcessSnapshotEntry {
            process_id: entry.th32ProcessID,
            parent_process_id: entry.th32ParentProcessID,
            exe_file: process_entry_exe_file(&entry),
        });
        has_entry = unsafe { Process32NextW(snapshot, &mut entry).is_ok() };
    }

    unsafe {
        let _ = CloseHandle(snapshot);
    }

    Ok(entries)
}

#[cfg(windows)]
fn process_entry_exe_file(entry: &PROCESSENTRY32W) -> String {
    let nul_index = entry
        .szExeFile
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(entry.szExeFile.len());

    String::from_utf16_lossy(&entry.szExeFile[..nul_index])
}

#[cfg(windows)]
fn process_loopback_capture_format_and_flags() -> (WAVEFORMATEX, MixFormat, u32) {
    // Process loopback's virtual audio client can return E_NOTIMPL for GetMixFormat.
    let block_align =
        PROCESS_LOOPBACK_CAPTURE_CHANNELS * (PROCESS_LOOPBACK_CAPTURE_BITS_PER_SAMPLE / 8);
    let wave_format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: PROCESS_LOOPBACK_CAPTURE_CHANNELS,
        nSamplesPerSec: PROCESS_LOOPBACK_CAPTURE_SAMPLE_RATE_HZ,
        nAvgBytesPerSec: PROCESS_LOOPBACK_CAPTURE_SAMPLE_RATE_HZ * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: PROCESS_LOOPBACK_CAPTURE_BITS_PER_SAMPLE,
        cbSize: 0,
    };
    let mix_format = MixFormat {
        sample_rate: PROCESS_LOOPBACK_CAPTURE_SAMPLE_RATE_HZ,
        channels: PROCESS_LOOPBACK_CAPTURE_CHANNELS,
        block_align,
        sample_kind: SampleKind::Int16,
    };
    let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

    (wave_format, mix_format, stream_flags)
}

#[cfg(windows)]
fn activate_process_exclude_audio_client(
    target_process_id: u32,
) -> Result<IAudioClient, AudioCaptureError> {
    let activation_params = ProcessLoopbackActivationParams::new(target_process_id)?;
    let (tx, rx) = std::sync::mpsc::channel();
    let completion_handler: IActivateAudioInterfaceCompletionHandler =
        ProcessLoopbackActivationHandler::new(tx).into();
    let _operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(activation_params.as_propvariant()),
            &completion_handler,
        )
    }
    .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;

    let raw_audio_client = rx.recv_timeout(Duration::from_secs(3)).map_err(|_| {
        AudioCaptureError::new(
            AudioCaptureErrorKind::WasapiUnavailable,
            "Windows process-exclude loopback activation did not complete within 3 seconds.",
            true,
        )
    })??;

    Ok(unsafe { IAudioClient::from_raw(raw_audio_client as *mut _) })
}

#[cfg(windows)]
struct ProcessLoopbackActivationParams {
    propvariant: PROPVARIANT,
}

#[cfg(windows)]
impl ProcessLoopbackActivationParams {
    fn new(target_process_id: u32) -> Result<Self, AudioCaptureError> {
        let params_size = std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>();
        let params_ptr = unsafe { CoTaskMemAlloc(params_size) };
        if params_ptr.is_null() {
            return Err(AudioCaptureError::new(
                AudioCaptureErrorKind::WasapiUnavailable,
                "Windows could not allocate process loopback activation parameters.",
                true,
            ));
        }

        unsafe {
            params_ptr.cast::<AUDIOCLIENT_ACTIVATION_PARAMS>().write(
                AUDIOCLIENT_ACTIVATION_PARAMS {
                    ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                    Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                        ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                            TargetProcessId: target_process_id,
                            ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                        },
                    },
                },
            );
        }

        let raw = windows::core::imp::PROPVARIANT {
            Anonymous: windows::core::imp::PROPVARIANT_0 {
                Anonymous: windows::core::imp::PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: windows::core::imp::PROPVARIANT_0_0_0 {
                        blob: windows::core::imp::BLOB {
                            cbSize: params_size as u32,
                            pBlobData: params_ptr.cast(),
                        },
                    },
                },
            },
        };

        Ok(Self {
            propvariant: unsafe { PROPVARIANT::from_raw(raw) },
        })
    }

    fn as_propvariant(&self) -> *const PROPVARIANT {
        &self.propvariant
    }
}

#[cfg(windows)]
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ProcessLoopbackActivationHandler {
    sender: Mutex<Option<std::sync::mpsc::Sender<Result<usize, AudioCaptureError>>>>,
}

#[cfg(windows)]
impl ProcessLoopbackActivationHandler {
    fn new(sender: std::sync::mpsc::Sender<Result<usize, AudioCaptureError>>) -> Self {
        Self {
            sender: Mutex::new(Some(sender)),
        }
    }
}

#[cfg(windows)]
impl IActivateAudioInterfaceCompletionHandler_Impl for ProcessLoopbackActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        activateoperation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let result = activateoperation
            .ok_or_else(|| {
                AudioCaptureError::new(
                    AudioCaptureErrorKind::WasapiUnavailable,
                    "Windows process-exclude loopback activation completed without an operation.",
                    true,
                )
            })
            .and_then(read_process_loopback_activation_result);

        if let Ok(mut sender) = self.sender.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(result);
            }
        }

        Ok(())
    }
}

#[cfg(windows)]
fn read_process_loopback_activation_result(
    operation: &IActivateAudioInterfaceAsyncOperation,
) -> Result<usize, AudioCaptureError> {
    let mut activate_result = HRESULT(0);
    let mut activated_interface = None;
    unsafe {
        operation
            .GetActivateResult(&mut activate_result, &mut activated_interface)
            .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    }

    if activate_result.is_err() {
        return Err(AudioCaptureError::new(
            AudioCaptureErrorKind::WasapiUnavailable,
            format!(
                "Windows process-exclude loopback activation failed with HRESULT 0x{:08X}.",
                activate_result.0 as u32
            ),
            true,
        ));
    }

    let activated_interface = activated_interface.ok_or_else(|| {
        AudioCaptureError::new(
            AudioCaptureErrorKind::WasapiUnavailable,
            "Windows process-exclude loopback activation returned no audio client.",
            true,
        )
    })?;
    let audio_client: IAudioClient = activated_interface
        .cast()
        .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;

    Ok(audio_client.into_raw() as usize)
}

#[cfg(windows)]
fn default_output_device_id(enumerator: &IMMDeviceEnumerator) -> Result<String, AudioCaptureError> {
    let default_device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .map_err(|error| windows_error(AudioCaptureErrorKind::DeviceUnavailable, error))?;
    device_id(&default_device)
}

#[cfg(windows)]
fn resolve_loopback_device(
    enumerator: &IMMDeviceEnumerator,
    device_id: Option<&str>,
) -> Result<IMMDevice, AudioCaptureError> {
    let Some(device_id) = device_id.filter(|value| !value.trim().is_empty()) else {
        return unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|error| windows_error(AudioCaptureErrorKind::DeviceUnavailable, error));
    };

    let mut wide_device_id: Vec<u16> = device_id.encode_utf16().collect();
    wide_device_id.push(0);

    unsafe { enumerator.GetDevice(PCWSTR::from_raw(wide_device_id.as_ptr())) }
        .map_err(|error| windows_error(AudioCaptureErrorKind::DeviceUnavailable, error))
}

#[cfg(windows)]
struct DefaultOutputDeviceTracker {
    captured_device_id: String,
    next_check_at: Instant,
}

#[cfg(windows)]
impl DefaultOutputDeviceTracker {
    fn new(captured_device_id: String) -> Self {
        Self {
            captured_device_id,
            next_check_at: Instant::now(),
        }
    }

    fn check(&mut self, enumerator: &IMMDeviceEnumerator) -> Result<(), AudioCaptureError> {
        if Instant::now() < self.next_check_at {
            return Ok(());
        }

        self.next_check_at = Instant::now() + Duration::from_millis(500);
        let current_default_id = default_output_device_id(enumerator).map_err(|_| {
            AudioCaptureError::new(
                AudioCaptureErrorKind::DeviceSwitchRequired,
                "Windows default output device is unavailable. Stop and restart capture after selecting an available output device.",
                true,
            )
        })?;

        if current_default_id == self.captured_device_id {
            return Ok(());
        }

        Err(AudioCaptureError::new(
            AudioCaptureErrorKind::DeviceSwitchRequired,
            "Windows default output device changed while capturing. Stop and restart capture so LinguaBridge can attach to the new output device.",
            true,
        ))
    }
}

#[cfg(windows)]
fn device_id(device: &IMMDevice) -> Result<String, AudioCaptureError> {
    let id = unsafe { device.GetId() }
        .map_err(|error| windows_error(AudioCaptureErrorKind::DeviceUnavailable, error))?;

    if id.is_null() {
        return Err(AudioCaptureError::new(
            AudioCaptureErrorKind::DeviceUnavailable,
            "WASAPI output device returned an empty device ID.",
            true,
        ));
    }

    let id_string = unsafe { id.to_string() }.map_err(|error| {
        AudioCaptureError::new(
            AudioCaptureErrorKind::DeviceUnavailable,
            format!("WASAPI output device ID is not valid UTF-16: {error}"),
            true,
        )
    })?;

    unsafe {
        CoTaskMemFree(Some(id.as_ptr().cast()));
    }

    Ok(id_string)
}

#[cfg(windows)]
fn device_name(device: &IMMDevice) -> Option<String> {
    let property_store = unsafe { device.OpenPropertyStore(STGM_READ) }.ok()?;
    let value = unsafe { property_store.GetValue(&PKEY_Device_FriendlyName) }.ok()?;
    let bstr = BSTR::try_from(&value).ok()?;
    let name = String::try_from(&bstr).ok()?;
    let trimmed_name = name.trim();

    if trimmed_name.is_empty() {
        None
    } else {
        Some(trimmed_name.to_string())
    }
}

#[cfg(windows)]
fn device_mix_format(device: &IMMDevice) -> Result<(Option<u32>, Option<u16>), AudioCaptureError> {
    let audio_client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
        .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    let mix_format_ptr = unsafe { audio_client.GetMixFormat() }
        .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    let mix_format = unsafe { read_mix_format(mix_format_ptr) };

    unsafe {
        CoTaskMemFree(Some(mix_format_ptr.cast()));
    }

    mix_format.map(|format| (Some(format.sample_rate), Some(format.channels)))
}

#[cfg(windows)]
struct ComApartment;

#[cfg(windows)]
impl ComApartment {
    fn initialize() -> Result<Self, AudioCaptureError> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
        Ok(Self)
    }
}

#[cfg(windows)]
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

#[cfg(windows)]
#[derive(Clone, Copy)]
struct MixFormat {
    sample_rate: u32,
    channels: u16,
    block_align: u16,
    sample_kind: SampleKind,
}

#[cfg(windows)]
#[derive(Clone, Copy)]
enum SampleKind {
    Float32,
    Int16,
    Int24,
    Int32,
}

#[cfg(windows)]
unsafe fn read_mix_format(format_ptr: *mut WAVEFORMATEX) -> Result<MixFormat, AudioCaptureError> {
    if format_ptr.is_null() {
        return Err(AudioCaptureError::new(
            AudioCaptureErrorKind::WasapiUnavailable,
            "WASAPI returned an empty mix format.",
            true,
        ));
    }

    let format = *format_ptr;
    let format_tag = format.wFormatTag as u32;
    let bits_per_sample = format.wBitsPerSample;
    let sample_rate = format.nSamplesPerSec;
    let channels = format.nChannels.max(1);
    let block_align = format.nBlockAlign;

    let mut sample_kind = match (format_tag, bits_per_sample) {
        (WAVE_FORMAT_PCM, 16) => SampleKind::Int16,
        (WAVE_FORMAT_PCM, 24) => SampleKind::Int24,
        (WAVE_FORMAT_PCM, 32) => SampleKind::Int32,
        (3, 32) => SampleKind::Float32,
        (WAVE_FORMAT_EXTENSIBLE_TAG, _) => {
            let subformat = read_extensible_subformat(format_ptr);
            sample_kind_from_subformat(subformat, bits_per_sample)?
        }
        _ => {
            return Err(AudioCaptureError::new(
                AudioCaptureErrorKind::WasapiUnavailable,
                format!(
                    "Unsupported WASAPI mix format tag {} with {} bits per sample.",
                    format_tag, bits_per_sample
                ),
                true,
            ));
        }
    };

    if format_tag == WAVE_FORMAT_EXTENSIBLE_TAG && bits_per_sample == 32 {
        let subformat = read_extensible_subformat(format_ptr);
        if subformat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_GUID {
            sample_kind = SampleKind::Float32;
        }
    }

    Ok(MixFormat {
        sample_rate,
        channels,
        block_align,
        sample_kind,
    })
}

#[cfg(windows)]
unsafe fn read_extensible_subformat(format_ptr: *const WAVEFORMATEX) -> GUID {
    let extensible_ptr = format_ptr.cast::<WAVEFORMATEXTENSIBLE>();
    std::ptr::addr_of!((*extensible_ptr).SubFormat).read_unaligned()
}

#[cfg(windows)]
fn sample_kind_from_subformat(
    subformat: GUID,
    bits_per_sample: u16,
) -> Result<SampleKind, AudioCaptureError> {
    if subformat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_GUID && bits_per_sample == 32 {
        return Ok(SampleKind::Float32);
    }

    if subformat == KSDATAFORMAT_SUBTYPE_PCM {
        return match bits_per_sample {
            16 => Ok(SampleKind::Int16),
            24 => Ok(SampleKind::Int24),
            32 => Ok(SampleKind::Int32),
            _ => Err(AudioCaptureError::new(
                AudioCaptureErrorKind::WasapiUnavailable,
                format!("Unsupported PCM sample width: {bits_per_sample} bits."),
                true,
            )),
        };
    }

    Err(AudioCaptureError::new(
        AudioCaptureErrorKind::WasapiUnavailable,
        "Unsupported WASAPI extensible sample subformat.",
        true,
    ))
}

#[cfg(windows)]
unsafe fn convert_packet_to_mono(
    data_ptr: *mut u8,
    frames: u32,
    format: &MixFormat,
) -> Result<Vec<f32>, AudioCaptureError> {
    if data_ptr.is_null() || frames == 0 {
        return Ok(Vec::new());
    }

    let byte_len = frames as usize * format.block_align as usize;
    let bytes = std::slice::from_raw_parts(data_ptr, byte_len);
    let channels = format.channels as usize;
    let bytes_per_sample = format.block_align as usize / channels;
    let mut mono = Vec::with_capacity(frames as usize);

    for frame_index in 0..frames as usize {
        let frame_offset = frame_index * format.block_align as usize;
        let mut sum = 0.0_f32;

        for channel_index in 0..channels {
            let sample_offset = frame_offset + channel_index * bytes_per_sample;
            sum += read_sample(bytes, sample_offset, format.sample_kind)?;
        }

        mono.push(sum / channels as f32);
    }

    Ok(mono)
}

#[cfg(windows)]
fn read_sample(bytes: &[u8], offset: usize, kind: SampleKind) -> Result<f32, AudioCaptureError> {
    match kind {
        SampleKind::Float32 => {
            let sample_bytes = bytes.get(offset..offset + 4).ok_or_else(sample_error)?;
            Ok(
                f32::from_le_bytes(sample_bytes.try_into().map_err(|_| sample_error())?)
                    .clamp(-1.0, 1.0),
            )
        }
        SampleKind::Int16 => {
            let sample_bytes = bytes.get(offset..offset + 2).ok_or_else(sample_error)?;
            Ok(
                i16::from_le_bytes(sample_bytes.try_into().map_err(|_| sample_error())?) as f32
                    / 32_768.0,
            )
        }
        SampleKind::Int24 => {
            let sample_bytes = bytes.get(offset..offset + 3).ok_or_else(sample_error)?;
            let mut value = (sample_bytes[0] as i32)
                | ((sample_bytes[1] as i32) << 8)
                | ((sample_bytes[2] as i32) << 16);
            if value & 0x800000 != 0 {
                value |= !0xFF_FFFF;
            }
            Ok(value as f32 / 8_388_608.0)
        }
        SampleKind::Int32 => {
            let sample_bytes = bytes.get(offset..offset + 4).ok_or_else(sample_error)?;
            Ok(
                i32::from_le_bytes(sample_bytes.try_into().map_err(|_| sample_error())?) as f32
                    / 2_147_483_648.0,
            )
        }
    }
}

#[cfg(windows)]
struct FrameEmitter {
    app: AppHandle,
    config: AudioCaptureConfig,
    input_rate: u32,
    resample_position: f64,
    input_carry: Vec<f32>,
    output_buffer: Vec<i16>,
    frame_samples: usize,
    sequence: u64,
}

#[cfg(windows)]
fn emit_capture_status_error(
    app: &AppHandle,
    config: &AudioCaptureConfig,
    active_device_id: &str,
    started_at_ms: u64,
    error: &AudioCaptureError,
) {
    let status = AudioCaptureStatus {
        state: AudioCaptureStatusKind::Error,
        active_device_id: Some(active_device_id.to_string()),
        started_at_ms: Some(started_at_ms),
        sample_rate_hz: config.sample_rate_hz,
        channels: config.channels,
        frame_duration_ms: config.frame_duration_ms,
        last_error: Some(error.message.clone()),
        last_error_kind: Some(error.kind),
    };

    let _ = app.emit(AUDIO_CAPTURE_STATUS_EVENT, status);
}

#[cfg(windows)]
impl FrameEmitter {
    fn new(config: AudioCaptureConfig, input_rate: u32, app: AppHandle) -> Self {
        let frame_samples =
            (config.sample_rate_hz as usize * config.frame_duration_ms as usize) / 1_000;
        Self {
            app,
            input_rate,
            config,
            resample_position: 0.0,
            input_carry: Vec::new(),
            output_buffer: Vec::with_capacity(frame_samples * 2),
            frame_samples,
            sequence: 0,
        }
    }

    fn push_samples(&mut self, samples: Vec<f32>) -> Result<(), AudioCaptureError> {
        if samples.is_empty() {
            return Ok(());
        }

        self.input_carry.extend(samples);
        let step = self.input_rate as f64 / self.config.sample_rate_hz as f64;

        while self.resample_position + 1.0 < self.input_carry.len() as f64 {
            let index = self.resample_position.floor() as usize;
            let fraction = (self.resample_position - index as f64) as f32;
            let current = self.input_carry[index];
            let next = self.input_carry[index + 1];
            let sample = current + (next - current) * fraction;
            self.output_buffer.push(float_to_i16(sample));
            self.resample_position += step;

            if self.output_buffer.len() >= self.frame_samples {
                self.emit_frame()?;
            }
        }

        let consumed = self.resample_position.floor() as usize;
        if consumed > 0 {
            self.input_carry.drain(0..consumed);
            self.resample_position -= consumed as f64;
        }

        Ok(())
    }

    fn emit_frame(&mut self) -> Result<(), AudioCaptureError> {
        let samples: Vec<i16> = self.output_buffer.drain(0..self.frame_samples).collect();
        let payload = AudioFramePayload {
            frame_id: format!("audio_frame_{}", self.sequence),
            sequence: self.sequence,
            timestamp_ms: now_ms(),
            sample_rate_hz: self.config.sample_rate_hz,
            channels: self.config.channels,
            frame_duration_ms: self.config.frame_duration_ms,
            samples,
        };
        self.sequence += 1;

        self.app.emit(AUDIO_FRAME_EVENT, payload).map_err(|error| {
            AudioCaptureError::new(
                AudioCaptureErrorKind::Internal,
                format!("Failed to emit audio frame to frontend: {error}"),
                true,
            )
        })
    }
}

#[cfg(windows)]
fn float_to_i16(value: f32) -> i16 {
    (value.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

#[cfg(windows)]
fn sample_error() -> AudioCaptureError {
    AudioCaptureError::new(
        AudioCaptureErrorKind::SampleRateConversionFailed,
        "WASAPI sample conversion read outside the audio packet.",
        true,
    )
}

#[cfg(windows)]
fn windows_error(kind: AudioCaptureErrorKind, error: windows::core::Error) -> AudioCaptureError {
    AudioCaptureError::new(kind, format!("Windows audio API failed: {error}"), true)
}

#[cfg(windows)]
fn windows_build_number() -> Option<u32> {
    #[repr(C)]
    struct OsVersionInfo {
        dw_os_version_info_size: u32,
        dw_major_version: u32,
        dw_minor_version: u32,
        dw_build_number: u32,
        dw_platform_id: u32,
        sz_csd_version: [u16; 128],
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(version_information: *mut OsVersionInfo) -> i32;
    }

    let mut version_info = OsVersionInfo {
        dw_os_version_info_size: std::mem::size_of::<OsVersionInfo>() as u32,
        dw_major_version: 0,
        dw_minor_version: 0,
        dw_build_number: 0,
        dw_platform_id: 0,
        sz_csd_version: [0; 128],
    };

    let status = unsafe { RtlGetVersion(&mut version_info) };
    (status >= 0).then_some(version_info.dw_build_number)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use windows::Win32::Media::Audio::{
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    };

    #[test]
    fn process_loopback_uses_explicit_pcm_format_and_autoconvert_flags() {
        let (wave_format, mix_format, stream_flags) = process_loopback_capture_format_and_flags();
        let format_tag = wave_format.wFormatTag;
        let sample_rate = wave_format.nSamplesPerSec;
        let channels = wave_format.nChannels;
        let bits_per_sample = wave_format.wBitsPerSample;
        let block_align = wave_format.nBlockAlign;
        let avg_bytes_per_sec = wave_format.nAvgBytesPerSec;
        let extra_size = wave_format.cbSize;

        assert_eq!(format_tag as u32, WAVE_FORMAT_PCM);
        assert_eq!(sample_rate, 44_100);
        assert_eq!(channels, 2);
        assert_eq!(bits_per_sample, 16);
        assert_eq!(block_align, 4);
        assert_eq!(avg_bytes_per_sec, 176_400);
        assert_eq!(extra_size, 0);

        assert_eq!(mix_format.sample_rate, 44_100);
        assert_eq!(mix_format.channels, 2);
        assert_eq!(mix_format.block_align, 4);
        assert!(matches!(mix_format.sample_kind, SampleKind::Int16));

        assert_eq!(
            stream_flags,
            AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
        );
    }

    #[test]
    fn process_loopback_prefers_webview2_subtree_as_exclusion_target() {
        let entries = vec![
            process_entry(100, 10, "lingua-bridge-desktop.exe"),
            process_entry(200, 100, "msedgewebview2.exe"),
            process_entry(201, 200, "msedgewebview2.exe"),
            process_entry(300, 100, "helper.exe"),
        ];

        let target = select_process_loopback_exclusion_target(100, &entries);

        assert_eq!(target, 200);
    }

    #[test]
    fn process_loopback_falls_back_to_current_process_without_webview2() {
        let entries = vec![
            process_entry(100, 10, "lingua-bridge-desktop.exe"),
            process_entry(300, 100, "helper.exe"),
        ];

        let target = select_process_loopback_exclusion_target(100, &entries);

        assert_eq!(target, 100);
    }

    fn process_entry(
        process_id: u32,
        parent_process_id: u32,
        exe_file: &str,
    ) -> ProcessSnapshotEntry {
        ProcessSnapshotEntry {
            process_id,
            parent_process_id,
            exe_file: exe_file.to_string(),
        }
    }
}

#[cfg(windows)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
