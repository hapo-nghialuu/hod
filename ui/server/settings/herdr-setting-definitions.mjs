// Typed allowlist of Herdr scalar settings the HOD UI may read and mutate.
//
// Only keys declared here can cross the HTTP boundary. Everything else in the
// config file stays untouchable: the TOML patcher is pointed at these exact
// dotted keys and validation runs through the schema below.
//
// Each definition carries public metadata the frontend renders controls from
// (Phase 04 contract) plus the runtime rules this server applies:
//   type          "string" | "boolean" | "integer"
//   enum          optional list of allowed values (string/integer)
//   min/max       optional integer bounds
//   restart       true  — a new Herdr process must start for the value to apply
//                 false — a server reload-config is enough
//   default       value assumed when the key is absent
//   description   short human phrase shown in the UI

const THEME_NAMES = Object.freeze([
  'catppuccin',
  'terminal',
  'tokyo-night',
  'dracula',
  'nord',
  'gruvbox',
  'one-dark',
  'solarized',
  'kanagawa',
  'rose-pine',
  'vesper',
]);

const LIGHT_THEME_NAMES = Object.freeze([...THEME_NAMES, 'catppuccin-latte']);

export const HERDR_SETTING_DEFINITIONS = Object.freeze({
  'theme.name': {
    type: 'string',
    enum: THEME_NAMES,
    restart: false,
    default: 'catppuccin',
    description: 'Active color theme.',
  },
  'theme.auto_switch': {
    type: 'boolean',
    restart: false,
    default: false,
    description: 'Switch theme with the system appearance.',
  },
  'theme.light_name': {
    type: 'string',
    enum: LIGHT_THEME_NAMES,
    restart: false,
    default: 'catppuccin-latte',
    description: 'Theme used in light mode.',
  },
  'theme.dark_name': {
    type: 'string',
    enum: THEME_NAMES,
    restart: false,
    default: 'catppuccin',
    description: 'Theme used in dark mode.',
  },
  'ui.agent_panel_sort': {
    type: 'string',
    enum: ['spaces', 'priority', 'workspaces'],
    restart: false,
    default: 'spaces',
    description: 'Sort order of agents in the sidebar panel.',
  },
  'ui.toast.delivery': {
    type: 'string',
    enum: ['off', 'herdr', 'terminal', 'system'],
    restart: false,
    default: 'off',
    description: 'How toast notifications are delivered.',
  },
  'ui.toast.delay_seconds': {
    type: 'integer',
    min: 0,
    max: 300,
    restart: false,
    default: 1,
    description: 'Seconds a toast stays visible.',
  },
  'ui.sound.enabled': {
    type: 'boolean',
    restart: false,
    default: true,
    description: 'Play sound events.',
  },
  'session.resume_agents_on_restore': {
    type: 'boolean',
    restart: true,
    default: true,
    description: 'Resume agents when the session is restored.',
  },
  'advanced.scrollback_limit_bytes': {
    type: 'integer',
    min: 262144,
    max: 1073741824,
    restart: true,
    default: 10000000,
    description: 'Per-pane scrollback buffer limit in bytes.',
  },
});

// Keep the misspelled early partial-file export as a compatibility alias while
// exposing the correctly named public constant for new callers.
export const HERRDR_SETTING_DEFINITIONS = HERDR_SETTING_DEFINITIONS;

export function herdrSettingDefs() {
  return HERDR_SETTING_DEFINITIONS;
}

// True when key is an allowlisted dotted path with a registered definition.
export function isAllowlistedSetting(key) {
  return Object.prototype.hasOwnProperty.call(HERDR_SETTING_DEFINITIONS, key);
}

// Coerce an incoming raw value against the definition. Returns either the
// validated value or null when it does not satisfy the schema.
export function validateSettingValue(key, raw) {
  const def = HERDR_SETTING_DEFINITIONS[key];
  if (!def) return null;

  switch (def.type) {
    case 'boolean':
      if (typeof raw !== 'boolean') return null;
      return raw;
    case 'integer': {
      const n = typeof raw === 'number' && Number.isInteger(raw) ? raw : NaN;
      if (!Number.isInteger(n)) return null;
      if (def.min !== undefined && n < def.min) return null;
      if (def.max !== undefined && n > def.max) return null;
      return n;
    }
    case 'string':
      if (typeof raw !== 'string') return null;
      if (def.enum && !def.enum.includes(raw)) return null;
      return raw;
    default:
      return null;
  }
}

// Serialize a validated value to the TOML literal form the patcher writes.
export function serializeSettingValue(def, value) {
  switch (def.type) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'integer':
      return String(value);
    case 'string': {
      // Escape only the two characters TOML requires inside basic strings.
      const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    default:
      throw new Error(`cannot serialize unknown setting type: ${def.type}`);
  }
}

// Public metadata map for the frontend. Values are serializable JSON only —
// no functions, no internal fields.
export function publicSettingMetadata() {
  const out = {};
  for (const [key, def] of Object.entries(HERDR_SETTING_DEFINITIONS)) {
    const metadata = {
      type: def.type,
      restart: def.restart,
      default: def.default,
      description: def.description,
    };
    if (def.enum) metadata.enum = [...def.enum];
    if (def.min !== undefined) metadata.min = def.min;
    if (def.max !== undefined) metadata.max = def.max;
    out[key] = metadata;
  }
  return out;
}
