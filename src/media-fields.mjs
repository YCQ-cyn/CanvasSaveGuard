const textFields = new Set(['prompt', 'composerContent', 'text', 'title', 'errorDetails']);

export function isMediaTextField(name, value, nodeType) {
  return typeof value === 'string' && (
    textFields.has(name)
    || name === 'content' && ['text', 'config'].includes(nodeType)
  );
}
