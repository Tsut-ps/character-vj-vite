/** フォーム入力中のイベントをグローバルショートカットから除外する */
export function isFormControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}
