/** Use the current document's clipboard. If the host denies it, leave focus in the editable preview. */
export async function pasteAgentPersona(input: HTMLTextAreaElement, onPaste: (text: string) => void, onManualPaste: () => void): Promise<void> {
  input.focus();
  let text: string | undefined;
  try { text = await input.ownerDocument.defaultView?.navigator.clipboard?.readText(); }
  catch { /* The native textarea still accepts a system paste. */ }
  if (!input.isConnected) return;
  if (text) onPaste(text);
  else onManualPaste();
}
