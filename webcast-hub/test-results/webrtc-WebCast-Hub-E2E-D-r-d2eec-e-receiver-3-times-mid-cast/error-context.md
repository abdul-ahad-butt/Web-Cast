# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: webrtc.spec.ts >> WebCast Hub E2E >> D: reload the receiver 3 times mid-cast
- Location: e2e\webrtc.spec.ts:186:3

# Error details

```
Test timeout of 30000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - generic [ref=e5]:
      - heading "WEBCAST HUB" [level=1] [ref=e6]
      - paragraph [ref=e7]: Cast anything to your screen, instantly.
    - button [ref=e8]
  - generic [ref=e12]:
    - textbox "Enter Room Code" [ref=e14]: BUE4
    - button "Generate New" [ref=e15]
  - main [ref=e16]:
    - generic [ref=e17] [cursor=pointer]:
      - heading "Cast Screen / Tab" [level=2] [ref=e22]
      - paragraph [ref=e23]: Instantly cast your browser tab or entire screen directly from the web.
    - generic [ref=e24] [cursor=pointer]:
      - heading "Cast Local Media" [level=2] [ref=e29]
      - paragraph [ref=e30]: Play downloaded videos and high-res images on the big screen.
    - generic [ref=e31] [cursor=pointer]:
      - heading "Connect Receiver" [level=2] [ref=e36]
      - paragraph [ref=e37]: Use this device as a display for incoming casts from anywhere.
  - generic [ref=e38]:
    - heading "Active Session" [level=3] [ref=e40]
    - generic [ref=e42]:
      - generic [ref=e47]:
        - paragraph [ref=e49]: Connecting to 1 receiver(s)...
        - paragraph [ref=e50]: "Playing: Screen Capture (1080p)"
      - button "Stop Casting" [ref=e51]
```