
# Welfare Support – FAQ Chatbot

A clean, modern FAQ chatbot with a full chat page and a floating embeddable widget.

## Features
- Quick-reply chips (suggested questions)
- Improved matching (token similarity + typo tolerance)
- Safer HTML rendering for FAQ answers (basic sanitiser)
- Commands: `/help`, `/clear` (also accepts `help`, `clear`, `restart`)
- Better accessibility (ARIA log, skip link, focus styles)
- Dark mode + reduced motion support
- Fixed widget toggle logic and improved close behaviour (ESC / click-outside)

✅ No chat data is stored — refreshing the page resets the chat.

## Live Preview
- Main app: https://apshone1992.github.io/Welfare-Support/
- Widget (embed this):

```html
<script src="https://apshone1992.github.io/Welfare-Support/public/widget.js"></script>
