export const MAX_TEXT_SCALARS = 256

/** Shared title/label semantics at producer and decoder boundaries. */
export function normalizeWireText(value) {
  if (value == null) return null
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
  return [...clean].slice(0, MAX_TEXT_SCALARS).join('') || null
}
