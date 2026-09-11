/**
 * Keyboard recording helpers for the Quick Chat global hotkey.
 *
 * Accelerators use Electron's syntax (e.g. `CommandOrControl+Shift+E`) so the
 * same stored value works on macOS, Windows and Linux.
 */

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Cmd"] as const;

const CODE_TO_ACCELERATOR_KEY: Record<string, string> = {
  Space: "Space",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Enter: "Enter",
  NumpadEnter: "numenter",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsubtract",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
  Delete: "Delete",
  Backspace: "Backspace",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
  Tab: "Tab"
};

for (let digit = 0; digit <= 9; digit += 1) {
  CODE_TO_ACCELERATOR_KEY[`Digit${digit}`] = String(digit);
}
for (let index = 0; index < 26; index += 1) {
  const letter = String.fromCharCode(65 + index);
  CODE_TO_ACCELERATOR_KEY[`Key${letter}`] = letter;
}
for (let fn = 1; fn <= 24; fn += 1) {
  CODE_TO_ACCELERATOR_KEY[`F${fn}`] = `F${fn}`;
}
for (let pad = 0; pad <= 9; pad += 1) {
  CODE_TO_ACCELERATOR_KEY[`Numpad${pad}`] = `num${pad}`;
}

export interface QuickHotkeyRecording {
  accelerator: string;
  /** True when the chord is registrable (has a main key plus a modifier). */
  valid: boolean;
}

function mainKeyFromEvent(event: KeyboardEvent): string {
  const byCode = CODE_TO_ACCELERATOR_KEY[event.code];
  if (byCode) return byCode;
  const key = event.key;
  if (key.length === 1) return key.toUpperCase();
  return "";
}

/** Convert a keydown recording into an accelerator. Modifier-only presses are
 * reported as invalid so the recorder UI can keep waiting for a main key. */
export function recordAcceleratorFromEvent(event: KeyboardEvent): QuickHotkeyRecording {
  const mainKey = mainKeyFromEvent(event);
  if (!mainKey) return { accelerator: "", valid: false };
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Cmd");
  if (modifiers.length === 0) return { accelerator: mainKey, valid: false };
  // A bare modifier combo like Shift+Esc is still registrable; keep it.
  return { accelerator: [...modifiers, mainKey].join("+"), valid: true };
}

const MODIFIER_ALIASES: Record<string, string> = {
  control: "Ctrl",
  ctrl: "Ctrl",
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  commandorctrl: "CommandOrControl",
  cmd: "Cmd",
  command: "Cmd",
  meta: "Cmd",
  super: "Cmd",
  alt: "Alt",
  option: "Alt",
  altgr: "AltGr",
  shift: "Shift"
};

/** Normalize a stored/typed accelerator string. Returns "" when the value
 * cannot be parsed into modifier+key form. */
export function normalizeAccelerator(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const modifiers: string[] = [];
  let mainKey = "";
  let hasCommandOrControl = false;
  for (const part of parts) {
    const alias = MODIFIER_ALIASES[part.toLowerCase()];
    if (alias && part.length > 1) {
      if (alias === "CommandOrControl") {
        hasCommandOrControl = true;
        continue;
      }
      if (!modifiers.includes(alias)) modifiers.push(alias);
      continue;
    }
    // Single-character tokens are main keys ("+" itself arrives as an empty
    // part because of the split, so map it back explicitly).
    if (part === "") continue;
    mainKey = part.length === 1 ? part.toUpperCase() : part;
  }
  if (!mainKey) return "";
  const ordered: string[] = [];
  if (hasCommandOrControl) ordered.push("CommandOrControl");
  for (const modifier of MODIFIER_ORDER) {
    if (modifiers.includes(modifier)) ordered.push(modifier);
  }
  for (const modifier of modifiers) {
    if (!MODIFIER_ORDER.includes(modifier as (typeof MODIFIER_ORDER)[number])
      && !ordered.includes(modifier)) ordered.push(modifier);
  }
  if (ordered.length === 0) return "";
  return [...ordered, mainKey].join("+");
}

/** Human-readable rendering for the settings UI (⌘⇧E style on macOS). */
export function formatAcceleratorForDisplay(accelerator: string, isMac: boolean): string {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return accelerator.trim();
  const parts = normalized.split("+");
  const mainKey = parts[parts.length - 1] ?? "";
  const modifiers = parts.slice(0, -1);
  if (!isMac) return normalized;
  const macSymbols: Record<string, string> = {
    CommandOrControl: "⌘",
    Ctrl: "⌃",
    Alt: "⌥",
    Shift: "⇧",
    Cmd: "⌘"
  };
  const renderedModifiers = modifiers.map((modifier) => macSymbols[modifier] ?? modifier);
  const renderedKey = mainKey.length === 1
    ? mainKey.toUpperCase()
    : mainKey;
  return `${renderedModifiers.join("")}${renderedKey}`;
}

export const DEFAULT_QUICK_CHAT_HOTKEY = "CommandOrControl+Shift+E";
