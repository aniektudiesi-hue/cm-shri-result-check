# WebSocket Paragraph Counter

This app checks this fixed page once per second:

```text
https://www.edudel.nic.in/cmshriapp/home.aspx
```

When the number of `<p>` tags inside `div.modal-body` becomes `5`, it sends one email alert:

```text
result came out man check
```

It will not keep spamming. It sends once for that `5` result, then re-arms only after the count changes away from `5`.

## Gmail Setup

Create a `.env` file in this folder:

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-sender@gmail.com
SMTP_PASS=your-gmail-app-password
ALERT_EMAIL_TO=aniketjha327@gmail.com
```

For Gmail, `SMTP_PASS` must be a Gmail App Password, not your normal Gmail password.

Then run:

```powershell
npm start
```

## Render Deploy

This app is Render-ready with `render.yaml`.

Before deploying, set these Render environment variables:

```text
SMTP_USER=aniketjha327@gmail.com
SMTP_PASS=<gmail-app-password>
SMTP_FROM=aniketjha327@gmail.com
ALERT_EMAIL_TO=aniketjha327@gmail.com
```

Render will use `DATA_DIR=/var/data` and a persistent disk to keep `subscribers.json`.
