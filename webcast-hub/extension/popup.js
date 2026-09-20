// extension/popup.ts
document.addEventListener("DOMContentLoaded", () => {
  const roomIdInput = document.getElementById("roomIdInput");
  const btnCastTab = document.getElementById("btnCastTab");
  const btnCastScreen = document.getElementById("btnCastScreen");
  const btnStopCast = document.getElementById("btnStopCast");
  const setupView = document.getElementById("setupView");
  const activeView = document.getElementById("activeView");
  const activeRoomCode = document.getElementById("activeRoomCode");
  const statusEl = document.getElementById("status");
  function updateStatus(msg) {
    statusEl.innerText = msg;
  }
  function setCasting(roomId) {
    setupView.classList.add("hidden");
    activeView.classList.remove("hidden");
    activeRoomCode.innerText = roomId;
    updateStatus("Casting active.");
  }
  function setStopped() {
    setupView.classList.remove("hidden");
    activeView.classList.add("hidden");
    updateStatus("Ready to cast.");
  }
  btnCastTab.addEventListener("click", async () => {
    const roomId = roomIdInput.value.trim();
    if (!roomId) return updateStatus("Please enter a room code.");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return updateStatus("No active tab found.");
    updateStatus("Starting cast...");
    chrome.runtime.sendMessage({
      type: "CAST_TAB",
      roomId,
      tabId: tab.id
    }, (response) => {
      if (response?.success) {
        setCasting(roomId);
      } else {
        updateStatus("Error: " + (response?.error || "Unknown"));
      }
    });
  });
  btnCastScreen.addEventListener("click", () => {
    const roomId = roomIdInput.value.trim();
    if (!roomId) return updateStatus("Please enter a room code.");
    chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab"], (streamId) => {
      if (!streamId) {
        updateStatus("Screen capture cancelled.");
        return;
      }
      updateStatus("Starting screen cast...");
      chrome.runtime.sendMessage({
        type: "CAST_DESKTOP",
        roomId,
        streamId
      }, (response) => {
        if (response?.success) {
          setCasting(roomId);
        } else {
          updateStatus("Error: " + (response?.error || "Unknown"));
        }
      });
    });
  });
  btnStopCast.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "STOP_CAST" }, () => {
      setStopped();
    });
  });
});
