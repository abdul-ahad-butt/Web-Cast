// service-worker.ts
async function setupOffscreenDocument(path) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(path)]
  });
  if (existingContexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: path,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "To stream the captured tab to the receiver"
  });
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAST_DESKTOP") {
    setupOffscreenDocument("offscreen.html").then(() => {
      chrome.runtime.sendMessage({
        target: "offscreen",
        type: "START_CAST",
        roomId: message.roomId,
        ownerToken: message.ownerToken,
        streamId: message.streamId
      }, (response) => {
        sendResponse(response);
      });
    });
    return true;
  }
  if (message.type === "CAST_TAB") {
    setupOffscreenDocument("offscreen.html").then(() => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId }, (streamId) => {
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "START_CAST",
          roomId: message.roomId,
          ownerToken: message.ownerToken,
          streamId
        }, (response) => {
          sendResponse(response);
        });
      });
    });
    return true;
  }
  if (message.type === "STOP_CAST") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_CAST" }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});
