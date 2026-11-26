// Open the side panel when the toolbar icon is clicked.
const enablePanel = () =>
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Ollama rejects requests that carry a chrome-extension:// Origin header (403)
// unless OLLAMA_ORIGINS is set. Instead, strip the Origin header, but ONLY on
// requests that this extension itself sends to the local Ollama server.
// Web pages keep sending their Origin, so Ollama's protection against websites stays on.
async function installOllamaRule() {
  const hosts = ['localhost:11434', '127.0.0.1:11434'];
  const rules = hosts.map((h, i) => ({
    id: 100 + i,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: {
      urlFilter: `|http://${h}/`,
      initiatorDomains: [chrome.runtime.id],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: rules.map((r) => r.id),
    addRules: rules,
  });
}

function setup() {
  enablePanel();
  installOllamaRule().catch(console.error);
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
