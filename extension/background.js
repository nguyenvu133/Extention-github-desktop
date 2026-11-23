chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({bridgeUrl:'http://127.0.0.1:17321', token:''}, v => {
    chrome.storage.local.set({bridgeUrl:v.bridgeUrl, token:v.token});
  });
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'OPEN_DASHBOARD') return;
  chrome.tabs.create({url: chrome.runtime.getURL('dashboard.html')});
  sendResponse({ok:true});
});
