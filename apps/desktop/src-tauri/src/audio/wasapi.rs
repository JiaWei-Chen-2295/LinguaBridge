use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

use super::error::{AudioCaptureError, AudioCaptureErrorKind};
use super::types::{
    AudioCaptureConfig, AudioDevice, AudioDeviceKind, AudioDeviceStatus, AudioFramePayload,
    AUDIO_FRAME_EVENT,
};

#[cfg(windows)]
use windows::{
    core::{BSTR, GUID, PCWSTR},
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Media::{
            Audio::{
                eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice,
                IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
                AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE,
                WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVE_FORMAT_PCM,
            },
            KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
            COINIT_MULTITHREADED, STGM_READ,
        },
    },
};

#[cfg(windows)]
const WAVE_FORMAT_EXTENSIBLE_TAG: u32 = 0xFFFE;

#[cfg(windows)]
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_GUID: GUID =
    GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

#[cfg(windows)]
struct CaptureThread {
    stop: Arc<AtomicBool>,
    join: JoinHandle<Result<(), AudioCaptureError>>,
}

#[cfg(windows)]
static CAPTURE_THREAD: OnceLock<Mutex<Option<CaptureThread>>> = OnceLock::new();

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
    let default_device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .map_err(|error| windows_error(AudioCaptureErrorKind::DeviceUnavailable, error))?;
    let default_device_id = device_id(&default_device)?;
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
) -> Result<(), AudioCaptureError> {
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
        Ok(Ok(())) => {
            *guard = Some(CaptureThread { stop, join });
            Ok(())
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
) -> Result<(), AudioCaptureError> {
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
fn run_capture_thread(
    config: AudioCaptureConfig,
    app: AppHandle,
    stop: Arc<AtomicBool>,
    ready_tx: std::sync::mpsc::Sender<Result<(), AudioCaptureError>>,
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
    ready_tx: &std::sync::mpsc::Sender<Result<(), AudioCaptureError>>,
) -> Result<(), AudioCaptureError> {
    let _com = ComApartment::initialize()?;
    let enumerator = create_device_enumerator()?;
    let device = resolve_loopback_device(&enumerator, config.device_id.as_deref())?;
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
    let mut emitter = FrameEmitter::new(config, mix_format.sample_rate, app);

    unsafe {
        audio_client
            .Start()
            .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))?;
    }
    let _ = ready_tx.send(Ok(()));

    while !stop.load(Ordering::SeqCst) {
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

    unsafe {
        let _ = audio_client.Stop();
    }

    Ok(())
}

#[cfg(windows)]
fn create_device_enumerator() -> Result<IMMDeviceEnumerator, AudioCaptureError> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
        .map_err(|error| windows_error(AudioCaptureErrorKind::WasapiUnavailable, error))
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
fn device_mix_format(
    device: &IMMDevice,
) -> Result<(Option<u32>, Option<u16>), AudioCaptureError> {
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
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
