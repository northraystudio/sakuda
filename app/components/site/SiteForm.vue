<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { BrowserStorageKind, BrowserStoragePatch } from '#shared/schemas/browserStorage'
import { BROWSER_STORAGE_KINDS } from '#shared/schemas/browserStorage'
import type { HeaderPatch } from '#shared/schemas/headers'
import type { SiteUpdateInput } from '#shared/schemas/site'
import type { RiskTag, SitePublic } from '#shared/types/api'
import { parseSeedPathLines } from '#shared/utils/seedPaths'

const props = defineProps<{
  initial?: SitePublic
  submitting: boolean
  errorMessage: string | null
  /** Where "Cancel" goes; no link is rendered when omitted. */
  cancelTo?: string
}>()

/** In create mode every header row carries its value, so the payload is
 * also a valid `SiteInput` for `POST`. */
const emit = defineEmits<{ submit: [payload: SiteUpdateInput] }>()

const isEditMode = computed(() => !!props.initial)

/** Engine badge labels shown in each section's legend — the same names the
 * site page uses on its Start-scan checkboxes, so a field's section says
 * which engine reads it. */
const ENGINE_BADGE = {
  all: 'All engines',
  discovery: 'Discovery',
  nuclei: 'Nuclei',
  zapFe: 'ZAP frontend',
  zapApi: 'ZAP API',
  dalfox: 'Dalfox',
} as const

const form = reactive({
  name: props.initial?.name ?? '',
  frontBaseUrl: props.initial?.frontBaseUrl ?? '',
  apiBaseUrl: props.initial?.apiBaseUrl ?? '',
  nucleiPaths: props.initial?.nucleiPaths ?? '',
  openapiUrl: props.initial?.openapiUrl ?? '',
  openapiJson: props.initial?.openapiJson ?? '',
  zapFeSeedPath: props.initial?.zapFeSeedPath ?? '/',
  discoverySeedPaths: props.initial?.discoverySeedPaths ?? '',
  crawlScopePaths: props.initial?.crawlScopePaths ?? '',
  excludePaths: props.initial?.excludePaths ?? '',
  nucleiRateLimit: props.initial?.nucleiRateLimit ?? 50,
  // null = no site override: the server falls back to its env value.
  nucleiMaxMinutes: props.initial?.nucleiMaxMinutes ?? null,
  nucleiConcurrency: props.initial?.nucleiConcurrency ?? null,
  zapApiMaxMinutes: props.initial?.zapApiMaxMinutes ?? 45,
  zapFeSpiderMaxMinutes: props.initial?.zapFeSpiderMaxMinutes ?? 5,
  nonLocalConfirmed: props.initial?.nonLocalConfirmed ?? false,
  allowMutatingRequests: props.initial?.allowMutatingRequests ?? false,
  nucleiEnabledRiskTags: [...(props.initial?.nucleiEnabledRiskTags ?? [])] as RiskTag[],
})

// Target paths has a second writer on the Edit page: the discovery panel in
// the `targets` slot saves/removes lines server-side and hands back the
// updated site. Mirror that here so "Save changes" PUTs the current list, not
// a stale one. On the Edit page there is no textarea for this field, so
// nothing of the user's is overwritten; the create form (no slot) never sees
// `initial` change.
watch(
  () => props.initial?.nucleiPaths,
  (next) => {
    if (next !== undefined) form.nucleiPaths = next
  },
)

/** nuclei risk-template groups the user can opt into (see server/domain/activeScan);
 * each is excluded by default and needs Active injection checks on to take effect. */
const RISK_TAG_GROUPS: { tag: RiskTag; label: string; help: string }[] = [
  {
    tag: 'intrusive',
    label: 'Known CVE exploit checks',
    help: 'runs the intrusive CVE templates that send a real exploit attempt.',
  },
  {
    tag: 'fuzz',
    label: 'Command injection / RCE',
    help: 'fuzzes for OS command execution — can run commands on the target host.',
  },
  {
    tag: 'dos',
    label: 'Denial of service (dangerous)',
    help: 'sends templates that may crash or hang the target. Leave off unless you can afford downtime.',
  },
]

// `shared/utils/localHost.ts` — auto-imported from `shared/utils/*`. A blank
// or unparsable frontBaseUrl must not show the confirmation gate on a fresh
// form — `siteRequiresConfirmation('', ...)` would otherwise report `true`
// because an unparsable URL is treated as "not local". openapiUrl is the one
// other user-supplied URL the server dereferences (ZAP's openapi job), so it
// must gate the same as frontBaseUrl/apiBaseUrl.
const requiresConfirmation = computed(() => {
  const front = form.frontBaseUrl.trim()
  if (front === '' || !URL.canParse(front)) return false
  return siteRequiresConfirmation(
    form.frontBaseUrl,
    form.apiBaseUrl || null,
    form.openapiUrl || null,
  )
})

// Headers are write-only: the API never returns values, only `headerNames`.
// In edit mode every stored name starts as a row with an empty value; a row
// left empty is sent as name-only, which `PUT` treats as "keep the stored
// value" (the merge lives in siteService.updateSite, not here).
// `storedName` is the name the row was created from (null for rows the user
// added). It is what lets a renamed stored row be told apart from a new,
// half-typed one — matching on the current name alone cannot do that.
type HeaderRow = { name: string; value: string; storedName: string | null }
const headerRows = reactive<HeaderRow[]>(
  (props.initial?.headerNames ?? []).map((name) => ({ name, value: '', storedName: name })),
)

function addHeaderRow() {
  headerRows.push({ name: '', value: '', storedName: null })
}

function removeHeaderRow(index: number) {
  headerRows.splice(index, 1)
}

/** A stored row whose name is untouched — the only case "unchanged" means keep. */
function isStoredHeader(row: HeaderRow): boolean {
  return row.storedName !== null && row.name === row.storedName
}

function emptyToNull(value: string): string | null {
  return value.trim() === '' ? null : value
}

// A row with a value is sent as-is. A row that came from a stored header is
// always sent, even with an empty (or cleared) name: `PUT` treats a name
// missing from the list as "delete", so dropping such a row would silently
// remove the stored header when the user only renamed it. Sent name-only, the
// server keeps the value when the name still matches and answers 422 when it
// does not — the only place that can tell, since the UI never sees values.
// A new row the user hasn't finished typing (no name, or no value) is dropped
// rather than submitted, since a server-side error would be confusing there.
function toHeaderPatch(row: HeaderRow): HeaderPatch | null {
  const isNewRow = row.storedName === null
  if (isNewRow && row.name.trim() === '') return null
  if (row.value.trim() !== '') return { name: row.name, value: row.value }
  return isNewRow ? null : { name: row.name }
}

// Browser storage follows the same write-only, per-row-patch contract as
// headers: the API only ever returns kind + name, so in edit mode every stored
// item starts as a row with an empty value; a row left empty is sent as
// kind+name only, which `PUT` treats as "keep the stored value" (the merge
// lives in siteService.updateSite, not here).
// `storedKey` is the (kind, name) the row was created from — see `storedName`.
type StorageRow = {
  kind: BrowserStorageKind
  name: string
  value: string
  storedKey: string | null
}
const storageKey = (i: { kind: string; name: string }) => `${i.kind}\n${i.name}`
const storageRows = reactive<StorageRow[]>(
  (props.initial?.browserStorageNames ?? []).map((i) => ({
    kind: i.kind,
    name: i.name,
    value: '',
    storedKey: storageKey(i),
  })),
)

function addStorageRow() {
  storageRows.push({ kind: 'localStorage', name: '', value: '', storedKey: null })
}

function removeStorageRow(index: number) {
  storageRows.splice(index, 1)
}

/** A stored row whose kind and name are untouched — see `isStoredHeader`. */
function isStoredStorage(row: StorageRow): boolean {
  return row.storedKey !== null && storageKey(row) === row.storedKey
}

// Mirrors toHeaderPatch: a stored row is never dropped (that would delete
// it), a new half-typed row is.
function toStoragePatch(row: StorageRow): BrowserStoragePatch | null {
  const isNewRow = row.storedKey === null
  if (isNewRow && row.name.trim() === '') return null
  if (row.value.trim() !== '') return { kind: row.kind, name: row.name, value: row.value }
  return isNewRow ? null : { kind: row.kind, name: row.name }
}

// Where crawling starts — for "Discover URLs" and for the ZAP frontend scan's
// spiders alike (both read resolveDiscoverySeeds) — is a choice, not a merge:
// one seed path (the site's entry point), or routes listed by hand, one crawl
// each. Nothing new is stored: "seed" saves the path in zapFeSeedPath with an
// empty list; "listed" saves the list, and its first line in zapFeSeedPath,
// which is what the session check looks for. On load, two or more listed
// lines mean "listed"; one or none means "seed". Switching keeps what was
// typed: seed → listed prefills an empty list with the seed path, listed →
// seed shows the first listed line.
type DiscoveryStart = 'seed' | 'listed'
const initialLines = parseSeedPathLines(form.discoverySeedPaths).lines
const discoveryStart = ref<DiscoveryStart>(initialLines.length >= 2 ? 'listed' : 'seed')
if (initialLines.length === 1 && initialLines[0]) form.zapFeSeedPath = initialLines[0]
const listedLines = computed(() => parseSeedPathLines(form.discoverySeedPaths).lines)
function setDiscoveryStart(mode: DiscoveryStart) {
  discoveryStart.value = mode
  if (mode === 'listed' && listedLines.value.length === 0 && form.zapFeSeedPath.trim() !== '')
    form.discoverySeedPaths = form.zapFeSeedPath.trim()
  if (mode === 'seed' && listedLines.value[0]) form.zapFeSeedPath = listedLines.value[0]
}
/** "From listed routes" with nothing listed would silently fall back to the
 * seed path on the server — refuse to submit instead of saving a lie. */
const listedRoutesMissing = computed(
  () => discoveryStart.value === 'listed' && listedLines.value.length === 0,
)
const seedPathMissing = computed(
  () => discoveryStart.value === 'seed' && form.zapFeSeedPath.trim() === '',
)

const canSubmit = computed(
  () =>
    !props.submitting &&
    (!requiresConfirmation.value || form.nonLocalConfirmed) &&
    !listedRoutesMissing.value &&
    !seedPathMissing.value,
)

// `v-model.number` leaves the bound field as the raw string when the input
// is empty or unparsable (Vue's `looseToNumber` gives up on non-numeric
// text) — fall back to the schema default rather than submitting a string
// or a non-finite number.
function toFiniteNumber(value: number | string, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** An optional number box: `v-model.number` yields '' once cleared, which
 * means "no override" (null), not a fallback number. */
function toOptionalNumber(value: number | string | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function buildPayload(): SiteUpdateInput {
  const base = {
    name: form.name,
    frontBaseUrl: form.frontBaseUrl,
    apiBaseUrl: emptyToNull(form.apiBaseUrl),
    nucleiPaths: form.nucleiPaths,
    openapiUrl: emptyToNull(form.openapiUrl),
    openapiJson: emptyToNull(form.openapiJson),
    // One choice, two stored fields (see discoveryStart above).
    zapFeSeedPath:
      discoveryStart.value === 'listed'
        ? (listedLines.value[0] ?? form.zapFeSeedPath)
        : form.zapFeSeedPath,
    discoverySeedPaths: discoveryStart.value === 'listed' ? form.discoverySeedPaths : '',
    crawlScopePaths: form.crawlScopePaths,
    excludePaths: form.excludePaths,
    nucleiRateLimit: toFiniteNumber(form.nucleiRateLimit, 50),
    nucleiMaxMinutes: toOptionalNumber(form.nucleiMaxMinutes),
    nucleiConcurrency: toOptionalNumber(form.nucleiConcurrency),
    zapApiMaxMinutes: toFiniteNumber(form.zapApiMaxMinutes, 45),
    zapFeSpiderMaxMinutes: toFiniteNumber(form.zapFeSpiderMaxMinutes, 5),
    nonLocalConfirmed: form.nonLocalConfirmed,
    allowMutatingRequests: form.allowMutatingRequests,
    nucleiEnabledRiskTags: form.nucleiEnabledRiskTags,
  }
  return {
    ...base,
    headers: headerRows.map(toHeaderPatch).filter((h) => h !== null),
    browserStorage: storageRows.map(toStoragePatch).filter((s) => s !== null),
  }
}

function handleSubmit() {
  if (!canSubmit.value) return
  emit('submit', buildPayload())
}
</script>

<template>
  <form data-testid="site-form" class="flex flex-col gap-10" @submit.prevent="handleSubmit">
    <div class="card flex flex-col gap-1 text-caption-sm text-mute" data-testid="form-legend">
      <p><span class="text-sale">*</span> = required. Everything else can stay empty.</p>
      <p>
        Sections follow the order in which the scan targets are determined — set them top to bottom:
        <strong>1 Site</strong> → <strong>2 Authentication</strong> →
        <strong>3 Active checks</strong> → <strong>4 Crawl</strong> → <strong>5 Targets</strong> →
        <strong>6 Engines</strong>. Each engine then derives its own targets from step 5 (shown on
        the site page). <strong>Dalfox</strong> has no settings of its own; it needs active checks.
      </p>
    </div>

    <!-- 1. Site: what every engine needs -->
    <fieldset data-testid="section-site" class="card border-hairline flex flex-col gap-6">
      <legend class="-ml-2 flex flex-wrap items-center gap-3 px-2">
        <span data-testid="section-step" class="text-caption-md text-mute font-mono">1</span>
        <span class="font-display text-heading-lg uppercase">Site</span>
        <span data-testid="engine-badge" class="badge">{{ ENGINE_BADGE.all }}</span>
      </legend>
      <p class="text-caption-sm text-mute" data-testid="section-note">
        Set first: every path below is relative to these URLs, and Exclude paths applies to the
        crawl and to every engine.
      </p>

      <div class="flex flex-col gap-2">
        <label for="site-name" class="text-caption-md font-medium text-ink"
          >Name <span class="text-sale">*</span></label
        >
        <input
          id="site-name"
          v-model="form.name"
          data-testid="name"
          type="text"
          required
          class="input-pill"
        />
      </div>

      <div class="flex flex-col gap-2">
        <label for="site-front-base-url" class="text-caption-md font-medium text-ink"
          >Front base URL <span class="text-sale">*</span></label
        >
        <input
          id="site-front-base-url"
          v-model="form.frontBaseUrl"
          data-testid="front-base-url"
          type="text"
          placeholder="http://localhost:4001"
          required
          class="input-pill"
        />
        <p class="text-caption-sm text-mute">
          Scheme + host + port of the web app, no trailing path. Every relative path below (target
          paths, seed paths) is appended to it.
        </p>
      </div>

      <div class="flex flex-col gap-2">
        <label for="site-api-base-url" class="text-caption-md font-medium text-ink"
          >API base URL (optional)</label
        >
        <input
          id="site-api-base-url"
          v-model="form.apiBaseUrl"
          data-testid="api-base-url"
          type="text"
          placeholder="https://api.example.com"
          class="input-pill"
        />
        <p class="text-caption-sm text-mute">
          Only when the API lives on a different origin than the front; leave empty when it is
          served from the front base URL. Used by "api:" target paths (Nuclei) and as the ZAP API
          target, which otherwise falls back to the front base URL.
        </p>
      </div>

      <div class="flex flex-col gap-2">
        <label for="site-exclude-paths" class="text-caption-md font-medium text-ink"
          >Exclude paths</label
        >
        <textarea
          id="site-exclude-paths"
          v-model="form.excludePaths"
          data-testid="exclude-paths"
          rows="4"
          class="textarea-soft"
        />
        <p class="text-caption-sm text-mute">
          Paths no engine may touch — one glob per line, "*" spans "/". Typical: "/logout",
          "/auth/refresh", "*/send-code" (anything that ends the session, sends mail, or deletes
          data).
        </p>
      </div>

      <div v-if="requiresConfirmation" class="card flex items-start gap-3">
        <input
          id="site-non-local-confirm"
          v-model="form.nonLocalConfirmed"
          data-testid="non-local-confirm"
          type="checkbox"
          class="mt-1"
        />
        <label for="site-non-local-confirm" class="text-caption-md text-ink">
          The target host is not local. I confirm I am authorized to scan it.
        </label>
      </div>
    </fieldset>

    <!-- 2. Authentication: the session the crawl and every engine use -->
    <fieldset data-testid="section-auth" class="card border-hairline flex flex-col gap-6">
      <legend class="-ml-2 flex flex-wrap items-center gap-3 px-2">
        <span data-testid="section-step" class="text-caption-md text-mute font-mono">2</span>
        <span class="font-display text-heading-lg uppercase">Authentication</span>
        <span data-testid="engine-badge" class="badge">{{ ENGINE_BADGE.all }}</span>
      </legend>
      <p class="text-caption-sm text-mute" data-testid="section-note">
        Set before discovering: without a session the crawl only sees the anonymous pages, and so
        will every engine.
      </p>

      <div class="flex flex-col gap-3">
        <span class="text-caption-md font-medium text-ink">Headers</span>
        <p class="text-caption-sm text-mute">
          Sent with every request by every engine (e.g. "Authorization: Bearer …", "Cookie: …").
          Stored encrypted, never shown again.
        </p>

        <p v-if="isEditMode" class="text-caption-sm text-mute">
          Leave a value empty to keep the stored one; type a new value to replace it. Remove a row
          to delete that header. Renaming a stored header requires its value.
        </p>

        <div data-testid="headers-editor" class="flex flex-col gap-3">
          <div
            v-for="(row, index) in headerRows"
            :key="index"
            class="flex flex-col gap-2 sm:flex-row sm:items-center"
          >
            <input
              v-model="row.name"
              :data-testid="`header-name-${index}`"
              type="text"
              placeholder="Header name"
              class="input-pill"
            />
            <input
              v-model="row.value"
              :data-testid="`header-value-${index}`"
              type="password"
              autocomplete="off"
              :placeholder="isStoredHeader(row) ? 'unchanged' : 'Header value'"
              class="input-pill"
            />
            <button
              type="button"
              :data-testid="`remove-header-${index}`"
              class="btn-secondary"
              @click="removeHeaderRow(index)"
            >
              Remove
            </button>
          </div>
          <button
            type="button"
            data-testid="add-header"
            class="btn-secondary self-start"
            @click="addHeaderRow"
          >
            Add header
          </button>
        </div>
      </div>

      <div class="flex flex-col gap-3">
        <span class="text-caption-md font-medium text-ink">Browser storage</span>
        <p class="text-caption-sm text-mute">
          Values seeded into ZAP's browser (localStorage / sessionStorage / cookie) before the Ajax
          spider crawls, so a single-page app renders as logged in. Headers (above) authenticate
          requests; this authenticates the UI. Stored encrypted, never shown again.
        </p>

        <p v-if="isEditMode" class="text-caption-sm text-mute">
          Leave a value empty to keep the stored one; type a new value to replace it. Remove a row
          to delete that item. Renaming a stored item requires its value.
        </p>

        <div data-testid="storage-editor" class="flex flex-col gap-3">
          <div
            v-for="(row, index) in storageRows"
            :key="index"
            class="flex flex-col gap-2 sm:flex-row sm:items-center"
          >
            <select v-model="row.kind" :data-testid="`storage-kind-${index}`" class="input-pill">
              <option v-for="kind in BROWSER_STORAGE_KINDS" :key="kind" :value="kind">
                {{ kind }}
              </option>
            </select>
            <input
              v-model="row.name"
              :data-testid="`storage-name-${index}`"
              type="text"
              placeholder="Key / cookie name"
              class="input-pill"
            />
            <input
              v-model="row.value"
              :data-testid="`storage-value-${index}`"
              type="password"
              autocomplete="off"
              :placeholder="isStoredStorage(row) ? 'unchanged' : 'Value'"
              class="input-pill"
            />
            <button
              type="button"
              :data-testid="`remove-storage-${index}`"
              class="btn-secondary"
              @click="removeStorageRow(index)"
            >
              Remove
            </button>
          </div>
          <button
            type="button"
            data-testid="add-storage"
            class="btn-secondary self-start"
            @click="addStorageRow"
          >
            Add item
          </button>
        </div>
      </div>
    </fieldset>

    <!-- 3. Active checks: the one opt-in discovery and every active engine mode read -->
    <fieldset data-testid="section-active" class="card border-hairline flex flex-col gap-6">
      <legend class="-ml-2 flex flex-wrap items-center gap-3 px-2">
        <span data-testid="section-step" class="text-caption-md text-mute font-mono">3</span>
        <span class="font-display text-heading-lg uppercase">Active checks</span>
        <span data-testid="engine-badge" class="badge">{{ ENGINE_BADGE.nuclei }}</span>
        <span data-testid="engine-badge" class="badge">{{ ENGINE_BADGE.zapFe }}</span>
        <span data-testid="engine-badge" class="badge">{{ ENGINE_BADGE.zapApi }}</span>
        <span data-testid="engine-badge" class="badge">{{ ENGINE_BADGE.dalfox }}</span>
      </legend>
      <p class="text-caption-sm text-mute" data-testid="section-note">
        Decide before discovering: it changes what the crawl does (form submission) and which saved
        lines the engines replay.
      </p>

      <div class="flex flex-col gap-2">
        <div class="flex items-start gap-3">
          <input
            id="site-allow-mutating-requests"
            v-model="form.allowMutatingRequests"
            data-testid="allow-mutating-requests"
            type="checkbox"
            class="mt-1"
          />
          <label for="site-allow-mutating-requests" class="text-caption-md font-medium text-ink">
            Active injection checks (sends attack payloads; may modify data)
          </label>
        </div>
        <p class="text-caption-sm text-mute">
          Off (default): passive and signature checks only — nothing that changes state. On: Nuclei
          runs its DAST templates (SQLi, LFI, SSTI, SSRF, …) against target paths that have query
          parameters, e.g. "/search?q=", and ZAP frontend adds an active scan (reflected / DOM XSS)
          over what its spider found. It also makes discovery active — the crawl submits forms
          before you review the results. Only enable this for an environment you own and can reset;
          it may corrupt or delete data.
        </p>
      </div>
    </fieldset>

    <!-- 4. Crawl: where "Discover URLs" (and the ZAP frontend spider) starts and how far it may go -->
    <fieldset data-testid="section-crawl" class="card border-hairline flex flex-col gap-6">
      <legend class="-ml-2 flex flex-wrap items-center gap-3 px-2">
        <span data-testid="section-step" class="text-caption-md text-mute font-mono">4</span>
        <span class="font-display text-heading-lg uppercase">Crawl</span>
        <span data-testid="engine-badge" class="badge">{{ ENGINE_BADGE.discovery }}</span>
      </legend>
      <p class="text-caption-sm text-mute" data-testid="section-note">
        Where crawling starts and how far it may go — for "Discover URLs" (ZAP's spiders and katana)
        and for the ZAP frontend scan's spiders alike. Run "Discover URLs" in Targets once these are
        set.
      </p>

      <fieldset class="flex flex-col gap-4" data-testid="discovery-start">
        <legend class="text-caption-md font-medium text-ink">
          Crawl starts <span class="text-sale">*</span>
        </legend>

        <div class="flex flex-col gap-2">
          <label class="text-body-md text-ink flex items-center gap-2">
            <input
              type="radio"
              name="discovery-start"
              value="seed"
              data-testid="discovery-start-seed"
              :checked="discoveryStart === 'seed'"
              @change="setDiscoveryStart('seed')"
            />
            From the seed path
            <span class="text-caption-sm text-mute">— the entry point; one crawl</span>
          </label>
          <input
            id="site-zap-fe-seed-path"
            v-model="form.zapFeSeedPath"
            data-testid="zap-fe-seed-path"
            type="text"
            placeholder="/"
            class="input-pill"
            :disabled="discoveryStart !== 'seed'"
          />
          <p
            v-if="seedPathMissing"
            class="text-sale text-caption-sm"
            data-testid="discovery-start-error"
          >
            Enter the path to start from, or choose "From listed routes".
          </p>
          <p class="text-caption-sm text-mute">
            Relative to the front base URL. "/" is fine for most sites; SPAs with hash routing use
            e.g. "/#/". With auth set, point it at a page only a logged-in user can reach (e.g.
            "/dashboard") so sakuda can warn when the session was not accepted.
          </p>
        </div>

        <div class="flex flex-col gap-2">
          <label class="text-body-md text-ink flex items-center gap-2">
            <input
              type="radio"
              name="discovery-start"
              value="listed"
              data-testid="discovery-start-listed"
              :checked="discoveryStart === 'listed'"
              @change="setDiscoveryStart('listed')"
            />
            From listed routes
            <span class="text-caption-sm text-mute">— one crawl per line</span>
          </label>
          <textarea
            id="site-discovery-seed-paths"
            v-model="form.discoverySeedPaths"
            data-testid="discovery-seed-paths"
            rows="3"
            placeholder="/#/&#10;/#/search?q=apple&#10;/#/basket&#10;/profile"
            class="textarea-soft"
            :disabled="discoveryStart !== 'listed'"
          />
          <p
            v-if="listedRoutesMissing"
            class="text-sale text-caption-sm"
            data-testid="discovery-start-error"
          >
            List at least one route, or choose "From the seed path".
          </p>
          <p class="text-caption-sm text-mute">
            One path per line, each crawled on its own (ZAP's spiders and katana in discovery, the
            ZAP frontend scan's spiders at scan time). List the pages of your app (hash routes are
            fine) so the APIs behind them are found — a single-page app usually needs its routes
            listed, since its root alone shows little. The first line is also where the traditional
            spider starts and what the session check looks for.
          </p>
        </div>
      </fieldset>

      <div class="flex flex-col gap-2">
        <label for="site-crawl-scope-paths" class="text-caption-md font-medium text-ink"
          >Crawl scope paths
          <span class="text-mute">(optional — empty crawls the whole origin)</span></label
        >
        <textarea
          id="site-crawl-scope-paths"
          v-model="form.crawlScopePaths"
          data-testid="crawl-scope-paths"
          rows="3"
          placeholder="/app&#10;/rest"
          class="textarea-soft"
        />
        <p class="text-caption-sm text-mute">
          Seed paths are where a crawl starts; this is how far it may go. One path prefix per line:
          "Discover URLs" (ZAP's spiders and katana) and the ZAP frontend scan's spider then only
          follow URLs under these prefixes (plus the API base URL and the seed pages themselves). An
          API outside the prefixes, e.g. "/api/…", is not included on its own — add it as a line or
          set it as the API base URL.
        </p>
      </div>
    </fieldset>

    <!-- 5. Targets: the one saved list every engine reads -->
    <fieldset data-testid="section-targets" class="card border-hairline flex flex-col gap-6">
      <legend class="-ml-2 flex flex-wrap items-center gap-3 px-2">
        <span data-testid="section-step" class="text-caption-md text-mute font-mono">5</span>
        <span class="font-display text-heading-lg uppercase">Targets</span>
        <span data-testid="engine-badge" class="badge">{{ ENGINE_BADGE.all }}</span>
      </legend>
      <p class="text-caption-sm text-mute" data-testid="section-note">
        The result of discovery plus your own lines: the one list every engine reads. What each
        engine does with it is shown on the site page.
      </p>

      <!-- The Edit page fills this slot with the discovery panel (discovered & saved ∪ add
           paths), which saves straight to the server; the fallback textarea is for a site that
           does not exist yet (New site), where nothing can be discovered. -->
      <slot name="targets">
        <div class="flex flex-col gap-2">
          <label for="site-nuclei-paths" class="text-caption-md font-medium text-ink"
            >Target paths
            <span class="text-mute">(optional — empty scans the base URL only)</span></label
          >
          <textarea
            id="site-nuclei-paths"
            v-model="form.nucleiPaths"
            data-testid="nuclei-paths"
            rows="4"
            placeholder="/&#10;/api/products&#10;/rest/products/search?q=a&#10;api:/health"
            class="textarea-soft"
          />
          <p class="text-caption-sm text-mute">
            The one saved list every engine reads — Nuclei scans it, the ZAP frontend requests it
            before its spiders run (and DOM-probes hash routes), ZAP API builds a request document
            from its non-GET lines, dalfox tests its GET lines. One path per line, relative to the
            front base URL; prefix "api:" only for paths on the API base URL. Once the site exists,
            "Discover URLs" on its Edit page fills this list from ZAP's spiders and katana; or
            hand-list the pages and endpoints you care about (top page, login, API routes with query
            params). A line may start with an HTTP method, e.g. "POST /api/x" — method omitted means
            GET; non-GET lines are replayed only under active checks. "#" starts a comment.
          </p>
        </div>
      </slot>
    </fieldset>

    <!-- 6. Nuclei: signature/DAST checks against the saved targets -->
    <fieldset data-testid="section-nuclei" class="card border-hairline flex flex-col gap-6">
      <legend class="-ml-2 flex flex-wrap items-center gap-3 px-2">
        <span data-testid="section-step" class="text-caption-md text-mute font-mono">6</span>
        <span class="font-display text-heading-lg uppercase">Nuclei</span>
        <span data-testid="engine-badge" class="badge">{{ ENGINE_BADGE.nuclei }}</span>
      </legend>
      <p class="text-caption-sm text-mute" data-testid="section-note">
        Engine limits only: its targets come from step 5.
      </p>

      <div class="flex flex-col gap-2 sm:max-w-80">
        <label for="site-nuclei-rate-limit" class="text-caption-md font-medium text-ink"
          >Rate limit (requests/s)</label
        >
        <input
          id="site-nuclei-rate-limit"
          v-model.number="form.nucleiRateLimit"
          data-testid="nuclei-rate-limit"
          type="number"
          required
          min="1"
          max="1000"
          class="input-pill"
        />
      </div>

      <div class="flex flex-col gap-2 sm:max-w-80">
        <label for="site-nuclei-max-minutes" class="text-caption-md font-medium text-ink"
          >Max minutes <span class="text-mute">(optional)</span></label
        >
        <input
          id="site-nuclei-max-minutes"
          v-model.number="form.nucleiMaxMinutes"
          data-testid="nuclei-max-minutes"
          type="number"
          min="1"
          max="600"
          class="input-pill"
        />
        <p class="text-caption-sm text-mute">
          Shared by every nuclei phase. Empty uses the server's SAKUDA_NUCLEI_MAX_MINUTES (default
          60).
        </p>
      </div>

      <div class="flex flex-col gap-2 sm:max-w-80">
        <label for="site-nuclei-concurrency" class="text-caption-md font-medium text-ink"
          >Concurrency <span class="text-mute">(optional)</span></label
        >
        <input
          id="site-nuclei-concurrency"
          v-model.number="form.nucleiConcurrency"
          data-testid="nuclei-concurrency"
          type="number"
          min="1"
          max="100"
          class="input-pill"
        />
        <p class="text-caption-sm text-mute">
          Templates run in parallel. Empty uses the server's SAKUDA_NUCLEI_CONCURRENCY (default 25).
        </p>
      </div>

      <div class="flex flex-col gap-2">
        <span class="text-caption-md font-medium text-ink">Extra risk template groups</span>
        <p class="text-caption-sm text-mute">
          Normally excluded even in active mode. Each needs Active injection checks (below) on to
          take effect.
        </p>
        <label
          v-for="group in RISK_TAG_GROUPS"
          :key="group.tag"
          class="flex items-start gap-3"
          :class="{ 'opacity-50': !form.allowMutatingRequests }"
        >
          <input
            v-model="form.nucleiEnabledRiskTags"
            :value="group.tag"
            :data-testid="`risk-tag-${group.tag}`"
            type="checkbox"
            :disabled="!form.allowMutatingRequests"
            class="mt-1"
          />
          <span class="text-caption-sm">
            <span class="font-medium text-ink">{{ group.label }}</span>
            <span class="text-mute"> — {{ group.help }}</span>
          </span>
        </label>
      </div>
    </fieldset>

    <!-- 6. ZAP frontend: crawl from the seed in a real browser -->
    <fieldset data-testid="section-zap-fe" class="card border-hairline flex flex-col gap-6">
      <legend class="-ml-2 flex flex-wrap items-center gap-3 px-2">
        <span data-testid="section-step" class="text-caption-md text-mute font-mono">6</span>
        <span class="font-display text-heading-lg uppercase">ZAP frontend</span>
        <span data-testid="engine-badge" class="badge">{{ ENGINE_BADGE.zapFe }}</span>
      </legend>
      <p class="text-caption-sm text-mute" data-testid="section-note">
        Engine limits only: it spiders from the step 4 crawl starts and requests the step 5 targets.
      </p>

      <div class="flex flex-col gap-2 sm:max-w-80">
        <label for="site-zap-fe-spider-max-minutes" class="text-caption-md font-medium text-ink"
          >Spider max minutes</label
        >
        <input
          id="site-zap-fe-spider-max-minutes"
          v-model.number="form.zapFeSpiderMaxMinutes"
          data-testid="zap-fe-spider-max-minutes"
          type="number"
          required
          min="1"
          max="120"
          class="input-pill"
        />
        <p class="text-caption-sm text-mute">
          Applies to the traditional spider and the Ajax spider each.
        </p>
      </div>

      <!-- The same site field as the ZAP API section's box: one active-scan
           budget, shown wherever an engine spends it. -->
      <div class="flex flex-col gap-2 sm:max-w-80">
        <label
          for="site-zap-fe-active-scan-max-minutes"
          class="text-caption-md font-medium text-ink"
          >Active scan max minutes</label
        >
        <input
          id="site-zap-fe-active-scan-max-minutes"
          v-model.number="form.zapApiMaxMinutes"
          data-testid="zap-fe-active-scan-max-minutes"
          type="number"
          required
          min="1"
          max="600"
          class="input-pill"
        />
        <p class="text-caption-sm text-mute">
          Caps the frontend active scan, which runs only when Active injection checks (below) is on.
          Shared with the ZAP API section — editing it here changes it there too.
        </p>
      </div>
    </fieldset>

    <!-- 6. ZAP API: active scan driven by an OpenAPI document -->
    <fieldset data-testid="section-zap-api" class="card border-hairline flex flex-col gap-6">
      <legend class="-ml-2 flex flex-wrap items-center gap-3 px-2">
        <span data-testid="section-step" class="text-caption-md text-mute font-mono">6</span>
        <span class="font-display text-heading-lg uppercase">ZAP API</span>
        <span data-testid="engine-badge" class="badge">{{ ENGINE_BADGE.zapApi }}</span>
      </legend>
      <p class="text-caption-sm text-mute" data-testid="section-note">
        Engine source and limits: an OpenAPI document, or a request document generated from the step
        5 non-GET lines under active checks.
      </p>

      <div class="flex flex-col gap-2">
        <label for="site-openapi-url" class="text-caption-md font-medium text-ink"
          >OpenAPI URL <span class="text-mute">(this or JSON below)</span></label
        >
        <input
          id="site-openapi-url"
          v-model="form.openapiUrl"
          data-testid="openapi-url"
          type="text"
          placeholder="http://localhost:8080/swagger/doc.json"
          class="input-pill"
        />
        <p class="text-caption-sm text-mute">
          URL of the OpenAPI/Swagger document ZAP imports for the active API scan. This engine stays
          unavailable until one of the two is set; target paths do not feed it.
        </p>
      </div>

      <div class="flex flex-col gap-2">
        <label for="site-openapi-json" class="text-caption-md font-medium text-ink"
          >OpenAPI JSON <span class="text-mute">(paste the document instead of a URL)</span></label
        >
        <textarea
          id="site-openapi-json"
          v-model="form.openapiJson"
          data-testid="openapi-json"
          rows="4"
          placeholder='{"openapi":"3.0.0","info":{"title":"x","version":"1"},"servers":[{"url":"http://localhost:4001"}],"paths":{"/rest/products/search":{"get":{"parameters":[{"name":"q","in":"query","schema":{"type":"string"}}],"responses":{"200":{"description":"ok"}}}}}}'
          class="textarea-soft"
        />
      </div>

      <div class="flex flex-col gap-2 sm:max-w-80">
        <label for="site-zap-api-max-minutes" class="text-caption-md font-medium text-ink"
          >Active scan max minutes</label
        >
        <input
          id="site-zap-api-max-minutes"
          v-model.number="form.zapApiMaxMinutes"
          data-testid="zap-api-max-minutes"
          type="number"
          required
          min="1"
          max="600"
          class="input-pill"
        />
        <p class="text-caption-sm text-mute">
          Caps the API scan. Shared with the ZAP frontend section, whose active scan it caps too
          when Active injection checks (below) is on — editing it here changes it there.
        </p>
      </div>
    </fieldset>

    <p v-if="errorMessage" data-testid="form-error" class="text-sale text-body-md">
      {{ errorMessage }}
    </p>

    <div class="flex flex-wrap items-center gap-3">
      <button type="submit" data-testid="submit" class="btn-primary" :disabled="!canSubmit">
        {{ isEditMode ? 'Save changes' : 'Create site' }}
      </button>
      <NuxtLink v-if="cancelTo" :to="cancelTo" data-testid="cancel" class="btn-secondary"
        >Cancel</NuxtLink
      >
    </div>
  </form>
</template>
