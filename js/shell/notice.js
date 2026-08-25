// Experimental notice strip — shell chrome that sits above the top strip and
// belongs to no tab. The markup ships statically in index.html; this module
// just reveals it. Deliberately permanent: no dismiss control, so the
// disclosure stays visible on every visit rather than being clicked away once.

export function mountNotice() {
  const el = document.querySelector("#wh-notice");
  if (!el) return;
  el.hidden = false;
}
