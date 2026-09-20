// Service Worker coordinates between popup and offscreen document

async function setupOffscreenDocument(path: string) {
  // Check if offscreen exists
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
    // Desktop capture must be initiated from popup or service worker?
    // Wait, desktopCapture.chooseDesktopMedia can be called from service worker or popup.
    // However, it requires a tab context if called from content script, but popup is fine.
    
    // We will let the popup request the streamId and send it to the offscreen document directly!
    // But the offscreen document might not be created yet.
    
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

    return true; // async
  }
  
  if (message.type === "CAST_TAB") {
    setupOffscreenDocument("offscreen.html").then(() => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId }, (streamId) => {
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "START_CAST",
          roomId: message.roomId,
          ownerToken: message.ownerToken,
          streamId: streamId
        }, (response) => {
          sendResponse(response);
        });
      });
    });

    return true; // async
  }

  if (message.type === "STOP_CAST") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_CAST" }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});
