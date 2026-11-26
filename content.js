// Watches <video> elements and tells the side panel when a video is ~95% watched.
// Used only for "Auto-note" mode; manual notes do not need this script.
const fired = new Set();

function isAdPlaying() {
  return !!document.querySelector('#movie_player.ad-showing, .ytp-ad-player-overlay');
}

function hook(video) {
  if (video.__courseNotesHooked) return;
  video.__courseNotesHooked = true;
  video.addEventListener('timeupdate', () => {
    const d = video.duration;
    if (!d || !isFinite(d) || d < 60) return;          // skip short clips / ads
    if (video.currentTime / d < 0.95) return;
    if (isAdPlaying()) return;
    const url = location.href;
    if (fired.has(url)) return;
    fired.add(url);
    chrome.runtime.sendMessage({ type: 'videoNearEnd', url }).catch(() => {
      // Side panel closed: nothing is listening. That's fine.
    });
  });
}

const scan = () => document.querySelectorAll('video').forEach(hook);
scan();
new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
