import type {
  TermEntry,
  TermEntryDomain,
  TermEntryKind
} from "@lingua-bridge/protocol";

export interface TermMatch {
  entry: TermEntry;
  matchedText: string;
  replacement: string;
}

export interface ProtectedTechnicalEntity {
  text: string;
  kind: "command" | "method" | "identifier";
  startIndex: number;
}

type BuiltInTermSpec = readonly [
  source: string,
  aliases?: readonly string[],
  kind?: TermEntryKind,
  priority?: number
];

const CLOUD_NATIVE_TERMS: readonly BuiltInTermSpec[] = [
  ["Kubernetes", ["K8s", "k eight s", "kates", "kube"], "product", 100],
  ["kubectl", ["cube control", "kube control", "kube cuddle"], "command", 100],
  ["kubelet", ["kube let"], "term", 80],
  ["kube-proxy", ["kube proxy"], "term", 80],
  ["control plane", [], "term", 70],
  ["worker node", [], "term", 70],
  ["pod", [], "term", 70],
  ["container", [], "term", 60],
  ["namespace", [], "term", 60],
  ["deployment", [], "term", 60],
  ["StatefulSet", ["stateful set"], "term", 70],
  ["DaemonSet", ["daemon set"], "term", 70],
  ["ReplicaSet", ["replica set"], "term", 70],
  ["service", [], "term", 50],
  ["ingress", [], "term", 60],
  ["ingress controller", [], "term", 70],
  ["Gateway API", [], "product", 70],
  ["ConfigMap", ["config map"], "term", 70],
  ["Secret", [], "term", 60],
  ["volume", [], "term", 50],
  ["persistent volume", [], "term", 60],
  ["PersistentVolumeClaim", ["PVC", "persistent volume claim"], "acronym", 70],
  ["storage class", [], "term", 60],
  ["sidecar proxy", ["side car proxy"], "term", 80],
  ["init container", [], "term", 60],
  ["readiness probe", [], "term", 60],
  ["liveness probe", [], "term", 60],
  ["startup probe", [], "term", 60],
  ["Helm", [], "product", 70],
  ["Helm chart", [], "term", 70],
  ["Kustomize", ["customize"], "product", 70],
  ["CRD", ["custom resource definition"], "acronym", 80],
  ["custom resource", [], "term", 60],
  ["operator", [], "term", 60],
  ["controller", [], "term", 60],
  ["reconciliation loop", [], "term", 70],
  ["etcd", ["et see dee"], "product", 80],
  ["API server", [], "term", 70],
  ["scheduler", [], "term", 60],
  ["cert-manager", ["cert manager"], "product", 70],
  ["Istio", [], "product", 70],
  ["Envoy", [], "product", 70],
  ["Linkerd", [], "product", 70],
  ["service mesh", [], "term", 70],
  ["Prometheus", [], "product", 70],
  ["Grafana", [], "product", 70],
  ["OpenTelemetry", ["OTel", "open telemetry"], "product", 70],
  ["Fluent Bit", [], "product", 60],
  ["containerd", ["container dee"], "product", 70],
  ["Docker", [], "product", 80],
  ["OCI", ["open container initiative"], "acronym", 60],
  ["image registry", [], "term", 60],
  ["Argo CD", ["argo see dee"], "product", 70],
  ["Flux", [], "product", 60],
  ["canary release", [], "term", 60],
  ["blue-green deployment", ["blue green deployment"], "term", 60],
  ["HPA", ["horizontal pod autoscaler"], "acronym", 70],
  ["VPA", ["vertical pod autoscaler"], "acronym", 70],
  ["node affinity", [], "term", 60],
  ["taint", [], "term", 60],
  ["toleration", [], "term", 60]
];

const FRONTEND_TERMS: readonly BuiltInTermSpec[] = [
  ["React", [], "product", 90],
  ["TypeScript", ["TS"], "product", 90],
  ["JavaScript", ["JS"], "product", 90],
  ["JSX", [], "file_format", 70],
  ["TSX", [], "file_format", 70],
  ["Vite", [], "product", 70],
  ["Next.js", ["Next JS"], "product", 70],
  ["Remix", [], "product", 60],
  ["Vue", [], "product", 70],
  ["Nuxt", [], "product", 60],
  ["Svelte", [], "product", 60],
  ["Angular", [], "product", 70],
  ["Tailwind CSS", ["tailwind"], "product", 70],
  ["CSS Modules", [], "term", 60],
  ["HTML", [], "acronym", 60],
  ["CSS", [], "acronym", 60],
  ["DOM", ["document object model"], "acronym", 70],
  ["Shadow DOM", [], "term", 70],
  ["Web Component", [], "term", 70],
  ["WebSocket", ["web socket"], "protocol", 80],
  ["fetch", [], "code_identifier", 60],
  ["Promise", [], "code_identifier", 60],
  ["async/await", ["async await"], "code_identifier", 70],
  ["useEffect", [], "code_identifier", 90],
  ["useMemo", [], "code_identifier", 80],
  ["useCallback", [], "code_identifier", 80],
  ["useState", [], "code_identifier", 80],
  ["React Hook", [], "term", 70],
  ["prop", [], "term", 50],
  ["state", [], "term", 50],
  ["hydration", [], "term", 60],
  ["server component", [], "term", 60],
  ["client component", [], "term", 60],
  ["virtual DOM", [], "term", 70],
  ["bundle", [], "term", 50],
  ["tree shaking", [], "term", 60],
  ["code splitting", [], "term", 60],
  ["webpack", [], "product", 70],
  ["Rollup", [], "product", 60],
  ["esbuild", ["ESBuild"], "product", 60],
  ["SWC", [], "product", 60],
  ["Babel", [], "product", 60],
  ["ESLint", [], "product", 60],
  ["Prettier", [], "product", 60],
  ["Playwright", [], "product", 60],
  ["Cypress", [], "product", 60],
  ["Storybook", [], "product", 60],
  ["localStorage", ["local storage"], "code_identifier", 70],
  ["IndexedDB", ["indexed dee bee"], "product", 70],
  ["service worker", [], "term", 60]
];

const BACKEND_TERMS: readonly BuiltInTermSpec[] = [
  ["Node.js", ["Node JS"], "product", 80],
  ["Fastify", [], "product", 70],
  ["Express", [], "product", 70],
  ["NestJS", ["Nest JS"], "product", 70],
  ["REST API", ["rest API"], "protocol", 70],
  ["GraphQL", ["graph Q L"], "protocol", 70],
  ["gRPC", ["gee R P C"], "protocol", 70],
  ["webhook", [], "term", 60],
  ["middleware", [], "term", 60],
  ["route handler", [], "term", 60],
  ["controller", [], "term", 50],
  ["DTO", ["data transfer object"], "acronym", 60],
  ["schema validation", [], "term", 60],
  ["JSON Schema", [], "term", 60],
  ["Zod", [], "product", 60],
  ["Prisma", [], "product", 70],
  ["ORM", ["object relational mapper"], "acronym", 60],
  ["SQL query", [], "term", 60],
  ["transaction", [], "term", 60],
  ["connection pool", [], "term", 60],
  ["migration", [], "term", 50],
  ["seed script", [], "term", 50],
  ["JWT", ["jay double you tee", "JSON web token"], "acronym", 70],
  ["OAuth", ["oh auth"], "protocol", 70],
  ["OpenID Connect", ["OIDC"], "protocol", 70],
  ["session cookie", [], "term", 60],
  ["CSRF", ["see surf"], "acronym", 60],
  ["CORS", ["cores"], "acronym", 60],
  ["rate limit", [], "term", 60],
  ["idempotency key", [], "term", 60],
  ["message queue", [], "term", 60],
  ["Kafka", [], "product", 70],
  ["RabbitMQ", ["rabbit M Q"], "product", 70],
  ["NATS", [], "product", 60],
  ["Redis", [], "product", 80],
  ["cache aside", [], "term", 60],
  ["pub/sub", ["pub sub"], "term", 60],
  ["worker", [], "term", 50],
  ["cron job", [], "term", 50],
  ["background job", [], "term", 50],
  ["microservice", [], "term", 60],
  ["monolith", [], "term", 60],
  ["API gateway", [], "term", 70],
  ["load balancer", [], "term", 60],
  ["reverse proxy", [], "term", 60],
  ["NGINX", ["engine x"], "product", 80],
  ["CDN", ["content delivery network"], "acronym", 60],
  ["object storage", [], "term", 60],
  ["S3", ["S three"], "product", 60],
  ["OSS", ["object storage service"], "product", 60]
];

const DATABASE_TERMS: readonly BuiltInTermSpec[] = [
  ["PostgreSQL", ["Postgres", "post gray S Q L"], "product", 90],
  ["Postgres", [], "product", 80],
  ["MySQL", ["my S Q L", "my sequel"], "product", 80],
  ["SQLite", ["S Q Lite"], "product", 70],
  ["MongoDB", ["mongo D B"], "product", 70],
  ["Elasticsearch", [], "product", 70],
  ["OpenSearch", [], "product", 60],
  ["ClickHouse", [], "product", 60],
  ["Cassandra", [], "product", 60],
  ["DynamoDB", ["dynamo D B"], "product", 60],
  ["index", [], "term", 50],
  ["B-tree", ["B tree"], "term", 60],
  ["hash index", [], "term", 60],
  ["full-text search", ["full text search"], "term", 60],
  ["query planner", [], "term", 60],
  ["execution plan", [], "term", 60],
  ["EXPLAIN", [], "command", 60],
  ["VACUUM", [], "command", 60],
  ["WAL", ["write ahead log"], "acronym", 70],
  ["replication", [], "term", 60],
  ["primary key", [], "term", 60],
  ["foreign key", [], "term", 60],
  ["unique constraint", [], "term", 60],
  ["isolation level", [], "term", 60],
  ["MVCC", ["multi version concurrency control"], "acronym", 70],
  ["deadlock", [], "term", 60],
  ["lock", [], "term", 50],
  ["row lock", [], "term", 60],
  ["materialized view", [], "term", 60],
  ["stored procedure", [], "term", 60],
  ["trigger", [], "term", 50],
  ["sharding", [], "term", 60],
  ["partitioning", [], "term", 60],
  ["eventual consistency", [], "term", 60],
  ["read replica", [], "term", 60],
  ["write ahead log", [], "term", 60]
];

const AI_ML_TERMS: readonly BuiltInTermSpec[] = [
  ["LLM", ["large language model"], "acronym", 90],
  ["large language model", [], "term", 70],
  ["transformer", [], "term", 70],
  ["attention", [], "term", 60],
  ["token", [], "term", 60],
  ["tokenizer", [], "term", 60],
  ["embedding", [], "term", 60],
  ["vector database", [], "term", 60],
  ["RAG", ["retrieval augmented generation"], "acronym", 80],
  ["retrieval augmented generation", [], "term", 70],
  ["prompt", [], "term", 60],
  ["prompt engineering", [], "term", 60],
  ["fine-tuning", ["fine tuning"], "term", 60],
  ["LoRA", [], "acronym", 60],
  ["adapter", [], "term", 50],
  ["inference", [], "term", 60],
  ["batch inference", [], "term", 60],
  ["streaming inference", [], "term", 60],
  ["hallucination", [], "term", 60],
  ["evaluation", [], "term", 50],
  ["benchmark", [], "term", 50],
  ["dataset", [], "term", 50],
  ["feature engineering", [], "term", 60],
  ["training loop", [], "term", 60],
  ["gradient descent", [], "term", 60],
  ["backpropagation", [], "term", 60],
  ["PyTorch", [], "product", 70],
  ["TensorFlow", [], "product", 70],
  ["JAX", [], "product", 60],
  ["ONNX", [], "file_format", 60],
  ["CUDA", [], "product", 70],
  ["GPU", ["graphics processing unit"], "acronym", 60],
  ["TPU", ["tensor processing unit"], "acronym", 60],
  ["quantization", [], "term", 60],
  ["int8", ["int eight"], "term", 60],
  ["FP16", ["F P sixteen"], "term", 60],
  ["BF16", ["B F sixteen"], "term", 60],
  ["model serving", [], "term", 60],
  ["LangChain", [], "product", 60],
  ["LlamaIndex", ["llama index"], "product", 60]
];

const DEVOPS_SYSTEMS_TERMS: readonly BuiltInTermSpec[] = [
  ["Git", [], "product", 80],
  ["GitHub", [], "product", 80],
  ["GitLab", [], "product", 70],
  ["pull request", ["PR"], "term", 60],
  ["merge request", ["MR"], "term", 60],
  ["branch", [], "term", 50],
  ["rebase", [], "command", 60],
  ["cherry-pick", ["cherry pick"], "command", 60],
  ["commit", [], "term", 50],
  ["CI/CD", ["see eye see dee", "continuous integration continuous delivery"], "acronym", 80],
  ["GitHub Actions", [], "product", 70],
  ["Dockerfile", [], "file_format", 70],
  ["docker-compose", ["docker compose"], "command", 70],
  ["Terraform", [], "product", 70],
  ["Ansible", [], "product", 60],
  ["Helmfile", [], "product", 60],
  ["Makefile", [], "file_format", 60],
  ["npm", [], "command", 70],
  ["pnpm", ["P N P M"], "command", 70],
  ["yarn", [], "command", 60],
  ["npx", ["N P X"], "command", 60],
  ["cargo", [], "command", 60],
  ["rustc", ["rust C"], "command", 60],
  ["Go", ["Golang"], "product", 70],
  ["Python", [], "product", 80],
  ["pip", [], "command", 60],
  ["virtualenv", ["virtual env"], "term", 60],
  ["Conda", [], "product", 60],
  ["JVM", ["Java virtual machine"], "acronym", 60],
  ["Maven", [], "product", 60],
  ["Gradle", [], "product", 60],
  ["Make", [], "command", 50],
  ["bash", [], "command", 60],
  ["PowerShell", [], "product", 70],
  ["CLI", ["command line interface"], "acronym", 60],
  ["SDK", ["software development kit"], "acronym", 60],
  ["API", ["application programming interface"], "acronym", 80],
  ["HTTP", [], "protocol", 70],
  ["HTTPS", [], "protocol", 70],
  ["TCP", [], "protocol", 60],
  ["UDP", [], "protocol", 60],
  ["TLS", [], "protocol", 60],
  ["DNS", [], "protocol", 60],
  ["URI", [], "protocol", 50],
  ["URL", [], "protocol", 50],
  ["JSON", [], "file_format", 70],
  ["YAML", ["Y A M L", "yaml"], "file_format", 70],
  ["XML", [], "file_format", 60],
  ["CSV", [], "file_format", 60],
  ["Markdown", [], "file_format", 60],
  ["Base64", ["base sixty four"], "term", 60],
  ["UTF-8", ["U T F eight"], "term", 60],
  ["regex", ["regular expression"], "term", 60],
  ["regular expression", [], "term", 60],
  ["parser", [], "term", 50],
  ["serializer", [], "term", 50],
  ["deserializer", [], "term", 50],
  ["protobuf", ["protocol buffers"], "file_format", 60],
  ["Avro", [], "file_format", 50],
  ["MessagePack", ["message pack"], "file_format", 50],
  ["Linux", [], "product", 70],
  ["Windows", [], "product", 70],
  ["macOS", ["Mac OS"], "product", 70],
  ["WSL", ["Windows subsystem for Linux"], "acronym", 60],
  ["process", [], "term", 50],
  ["thread", [], "term", 50],
  ["coroutine", [], "term", 50],
  ["async runtime", [], "term", 60],
  ["event loop", [], "term", 60],
  ["memory leak", [], "term", 60],
  ["garbage collection", ["GC"], "term", 60],
  ["stack trace", [], "term", 60],
  ["segmentation fault", ["segfault"], "term", 60],
  ["race condition", [], "term", 60],
  ["mutex", [], "term", 60],
  ["semaphore", [], "term", 60],
  ["lock-free", ["lock free"], "term", 60],
  ["Big O", ["big O"], "term", 60],
  ["O(n)", ["O of N"], "term", 60],
  ["O(log n)", ["O log N"], "term", 60],
  ["binary search", [], "term", 60],
  ["hash map", [], "term", 60],
  ["array", [], "term", 50],
  ["linked list", [], "term", 50],
  ["heap", [], "term", 50],
  ["stack", [], "term", 50],
  ["queue", [], "term", 50],
  ["trie", [], "term", 50],
  ["graph", [], "term", 50],
  ["BFS", ["breadth first search"], "acronym", 60],
  ["DFS", ["depth first search"], "acronym", 60],
  ["Dijkstra", ["Dijkstra's algorithm"], "term", 60],
  ["compiler", [], "term", 50],
  ["interpreter", [], "term", 50],
  ["bytecode", [], "term", 50],
  ["JIT", ["just in time"], "acronym", 60],
  ["AST", ["abstract syntax tree"], "acronym", 60],
  ["linter", [], "term", 50],
  ["formatter", [], "term", 50],
  ["unit test", [], "term", 50],
  ["integration test", [], "term", 50],
  ["E2E test", ["end to end test"], "term", 50],
  ["mock", [], "term", 50],
  ["stub", [], "term", 50],
  ["fixture", [], "term", 50],
  ["snapshot test", [], "term", 50],
  ["authentication", [], "term", 50],
  ["authorization", [], "term", 50],
  ["encryption", [], "term", 50],
  ["hashing", [], "term", 50],
  ["bcrypt", ["B crypt"], "term", 50],
  ["Argon2", ["argon two"], "term", 50],
  ["HMAC", [], "acronym", 50],
  ["RSA", [], "acronym", 50],
  ["ECDSA", [], "acronym", 50],
  ["Ed25519", ["ed twenty five five nineteen"], "term", 50],
  ["XSS", ["cross site scripting"], "acronym", 60],
  ["SQL injection", [], "term", 60],
  ["SSRF", ["server side request forgery"], "acronym", 60],
  ["OWASP", [], "acronym", 60],
  ["CVE", [], "acronym", 60],
  ["vulnerability", [], "term", 50],
  ["zero trust", [], "term", 50],
  ["IAM", ["identity and access management"], "acronym", 60],
  ["RBAC", ["role based access control"], "acronym", 60],
  ["ACL", ["access control list"], "acronym", 60]
];

export const BUILT_IN_TERM_ENTRIES: TermEntry[] = [
  ...buildBuiltInTerms("cloud_native", CLOUD_NATIVE_TERMS),
  ...buildBuiltInTerms("frontend", FRONTEND_TERMS),
  ...buildBuiltInTerms("backend", BACKEND_TERMS),
  ...buildBuiltInTerms("database", DATABASE_TERMS),
  ...buildBuiltInTerms("ai_ml", AI_ML_TERMS),
  ...buildBuiltInTerms("systems", DEVOPS_SYSTEMS_TERMS),
  keepSourceTerm(
    "builtin_general_cs_realtime_gateway",
    "Realtime Gateway",
    ["gateway"],
    "general_cs",
    "term",
    70
  ),
  keepSourceTerm(
    "builtin_general_cs_qwen",
    "Qwen",
    [],
    "general_cs",
    "product",
    70
  ),
  keepSourceTerm(
    "builtin_general_cs_qwen_mt",
    "Qwen-MT",
    ["Qwen MT"],
    "general_cs",
    "product",
    70
  ),
  keepSourceTerm(
    "builtin_general_cs_transcript",
    "transcript",
    [],
    "general_cs",
    "term",
    50
  )
];

export function mergeTermEntries(userEntries: TermEntry[]): TermEntry[] {
  const entriesBySource = new Map<string, TermEntry>();
  for (const entry of [...BUILT_IN_TERM_ENTRIES, ...userEntries]) {
    entriesBySource.set(normalizeTermKey(entry.source), cloneTermEntry(entry));
  }

  return Array.from(entriesBySource.values());
}

export function findTermMatches(
  sourceText: string,
  entries: TermEntry[]
): TermMatch[] {
  const matches: TermMatch[] = [];
  for (const entry of entries) {
    const matchedText = findMatchedVariant(sourceText, entry);
    if (matchedText === undefined) {
      continue;
    }

    const replacement =
      entry.mode === "fixed_translation" ? entry.target ?? entry.source : entry.source;
    matches.push({
      entry,
      matchedText,
      replacement
    });
  }

  return matches;
}

export function termNames(matches: TermMatch[]): string[] {
  return Array.from(new Set(matches.map((match) => match.entry.source)));
}

export function applyTermPolicy(
  sourceText: string,
  targetText: string,
  entries: TermEntry[]
): { targetText: string; termsHit: string[] } {
  const matches = findTermMatches(sourceText, entries);
  const protectedEntities = protectTechnicalEntities(sourceText);
  let constrainedTarget = targetText.trim();

  for (const match of matches) {
    if (match.entry.mode === "keep_source") {
      constrainedTarget = ensureRequiredTerm(
        constrainedTarget,
        match.entry.source,
        termVariants(match.entry)
      );
      continue;
    }

    if (match.entry.target !== undefined) {
      constrainedTarget = ensureRequiredTerm(constrainedTarget, match.entry.target, [
        match.entry.target
      ]);
    }
  }

  for (const entity of protectedEntities) {
    constrainedTarget = ensureRequiredTerm(constrainedTarget, entity.text, [
      entity.text
    ]);
  }

  return {
    targetText: constrainedTarget,
    termsHit: Array.from(
      new Set([
        ...termNames(matches),
        ...protectedEntities.map((entity) => entity.text)
      ])
    )
  };
}

export function protectTechnicalEntities(
  sourceText: string
): ProtectedTechnicalEntity[] {
  const candidates = [
    ...matchTechnicalPattern(
      sourceText,
      /\b(?:kubectl|docker|npm|npx|pnpm|yarn|git|cargo|go|python|pip|psql|redis-cli|curl)\b(?:\s+(?:[A-Za-z0-9_./:@=-]+|--?[A-Za-z0-9][A-Za-z0-9-]*(?:=[A-Za-z0-9_./:@-]+)?)){1,8}/gu,
      "command"
    ),
    ...matchTechnicalPattern(
      sourceText,
      /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\(\)/gu,
      "method"
    ),
    ...matchTechnicalPattern(
      sourceText,
      /\b[A-Za-z_$][A-Za-z0-9_$]*(?:[A-Z][A-Za-z0-9_$]*)+\b/gu,
      "identifier"
    )
  ];

  const selected: ProtectedTechnicalEntity[] = [];
  for (const candidate of candidates.sort(
    (left, right) =>
      left.startIndex - right.startIndex || right.text.length - left.text.length
  )) {
    if (
      candidate.text.length < 2 ||
      selected.some((existing) => rangesOverlap(existing, candidate))
    ) {
      continue;
    }
    selected.push(candidate);
  }

  return selected.sort((left, right) => left.startIndex - right.startIndex);
}

export function normalizeTechnicalSourceText(
  sourceText: string,
  entries: TermEntry[]
): string {
  let normalized = sourceText;
  const replacements: Array<{ alias: string; source: string }> = [];
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      if (
        alias.trim().length > 0 &&
        alias.toLowerCase() !== entry.source.toLowerCase()
      ) {
        replacements.push({ alias, source: entry.source });
      }
    }
  }

  for (const replacement of replacements.sort(
    (left, right) => right.alias.length - left.alias.length
  )) {
    normalized = normalized.replace(
      wholePhrasePattern(replacement.alias),
      replacement.source
    );
  }
  return normalized;
}

export function buildTermPrompt(matches: TermMatch[]): string {
  if (matches.length === 0) {
    return "No glossary hits.";
  }

  return matches
    .map((match) => {
      if (match.entry.mode === "keep_source") {
        return `- Keep "${match.entry.source}" in English.`;
      }

      return `- Translate "${match.entry.source}" as "${match.entry.target ?? match.entry.source}".`;
    })
    .join("\n");
}

function keepSourceTerm(
  id: string,
  source: string,
  aliases: readonly string[] = [],
  domain?: TermEntryDomain,
  kind: TermEntryKind = "term",
  priority = 50
): TermEntry {
  const entry: TermEntry = {
    id,
    source,
    mode: "keep_source",
    aliases: [...aliases],
    kind,
    priority
  };
  if (domain !== undefined) {
    entry.domain = domain;
  }
  return entry;
}

function buildBuiltInTerms(
  domain: TermEntryDomain,
  specs: readonly BuiltInTermSpec[]
): TermEntry[] {
  return specs.map(([source, aliases = [], kind = "term", priority = 50]) =>
    keepSourceTerm(
      `builtin_${domain}_${slugTerm(source)}`,
      source,
      aliases,
      domain,
      kind,
      priority
    )
  );
}

function matchTechnicalPattern(
  sourceText: string,
  pattern: RegExp,
  kind: ProtectedTechnicalEntity["kind"]
): ProtectedTechnicalEntity[] {
  const matches: ProtectedTechnicalEntity[] = [];
  for (const match of sourceText.matchAll(pattern)) {
    const text = match[0].replace(/[,.!?;:]$/u, "");
    if (text.trim().length === 0) {
      continue;
    }
    matches.push({
      text,
      kind,
      startIndex: match.index ?? 0
    });
  }
  return matches;
}

function rangesOverlap(
  left: ProtectedTechnicalEntity,
  right: ProtectedTechnicalEntity
): boolean {
  const leftEnd = left.startIndex + left.text.length;
  const rightEnd = right.startIndex + right.text.length;
  return left.startIndex < rightEnd && right.startIndex < leftEnd;
}

function cloneTermEntry(entry: TermEntry): TermEntry {
  const cloned: TermEntry = {
    id: entry.id,
    source: entry.source,
    mode: entry.mode,
    aliases: [...entry.aliases]
  };
  if (entry.userId !== undefined) {
    cloned.userId = entry.userId;
  }
  if (entry.target !== undefined) {
    cloned.target = entry.target;
  }
  if (entry.domain !== undefined) {
    cloned.domain = entry.domain;
  }
  if (entry.kind !== undefined) {
    cloned.kind = entry.kind;
  }
  if (entry.priority !== undefined) {
    cloned.priority = entry.priority;
  }
  return cloned;
}

function findMatchedVariant(
  sourceText: string,
  entry: TermEntry
): string | undefined {
  const lowerSource = sourceText.toLowerCase();
  return termVariants(entry).find((variant) =>
    lowerSource.includes(variant.toLowerCase())
  );
}

function termVariants(entry: TermEntry): string[] {
  return Array.from(new Set([entry.source, ...entry.aliases].filter(isNonEmpty)));
}

function ensureRequiredTerm(
  targetText: string,
  requiredTerm: string,
  acceptableTerms: string[]
): string {
  const lowerTarget = targetText.toLowerCase();
  if (
    acceptableTerms.some((term) => lowerTarget.includes(term.toLowerCase())) ||
    lowerTarget.includes(requiredTerm.toLowerCase())
  ) {
    return targetText;
  }

  return `${targetText} (${requiredTerm})`;
}

function normalizeTermKey(value: string): string {
  return value.trim().toLowerCase();
}

function slugTerm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function wholePhrasePattern(value: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegExp(value)}(?![A-Za-z0-9_])`,
    "giu"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}
