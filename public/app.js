const form = document.querySelector("#email-form");
const input = document.querySelector("#email");
const count = document.querySelector("#count");
const connection = document.querySelector("#connection");
const checkedAt = document.querySelector("#checked-at");
const message = document.querySelector("#message");
const pulse = document.querySelector("#pulse");
const subscribersList = document.querySelector("#subscribers");
const checkingScreen = document.querySelector("#checking-screen");
const announcedScreen = document.querySelector("#announced-screen");
const checkNow = document.querySelector("#check-now");
const resultUrl = "https://www.edudel.nic.in/cmshriapp/home.aspx";
let socket;

checkNow.href = resultUrl;

connect();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = input.value.trim();
  if (!email) return;

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setMessage("WebSocket is reconnecting. Try again in a moment.", true);
    connect();
    return;
  }

  socket.send(JSON.stringify({ type: "subscribe", email }));
  setMessage("Saving your email...");
});

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}`);

  socket.addEventListener("open", () => {
    connection.textContent = "Online";
    setMessage("Checking result in the background...");
    watchFixedUrl();
    socket.send(JSON.stringify({ type: "list" }));
  });

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "ready" || data.type === "watching") {
      if (data.subscribers) renderSubscribers(data.subscribers);
      setMessage("Checking result in the background...");
      return;
    }

    if (data.type === "subscribed") {
      setMessage(data.message, !data.ok);
      if (data.subscribers) renderSubscribers(data.subscribers);
      if (data.ok) input.value = "";
      return;
    }

    if (data.type === "subscribers") {
      renderSubscribers(data.subscribers);
      return;
    }

    if (data.type === "count") {
      count.textContent = data.count >= 5 ? "Ready" : "Checking";
      checkedAt.textContent = new Date(data.checkedAt).toLocaleTimeString();

      if (data.count >= 5) {
        showAnnouncedScreen();
      }

      if (data.alert?.sent) {
        setMessage("Result alert email sent.");
        return;
      }

      if (data.count === 5 && data.alert?.reason === "smtp-not-configured") {
        setMessage("Result detected, but email settings are not configured.", true);
        return;
      }

      if (data.count === 5 && data.alert?.reason === "no-subscribers") {
        setMessage("Result detected. Add an email to receive alerts.");
        return;
      }

      setMessage(
        data.count >= 5
          ? "Result may be ready. Email alerts are active."
          : "Checking result in the background..."
      );
      return;
    }

    if (data.type === "error") {
      setMessage(data.message, true);
    }
  });

  socket.addEventListener("close", () => {
    connection.textContent = "Offline";
    setMessage("WebSocket closed. Reconnecting...", true);
    window.setTimeout(connect, 1200);
  });

  socket.addEventListener("error", () => {
    connection.textContent = "Error";
    setMessage("WebSocket error.", true);
  });
}

function setMessage(text, isError = false) {
  message.textContent = text;
  pulse.classList.toggle("error", isError);
}

function watchFixedUrl() {
  socket.send(JSON.stringify({ type: "watch" }));
}

function renderSubscribers(subscribers = []) {
  subscribersList.replaceChildren();

  if (subscribers.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No emails added yet.";
    subscribersList.append(item);
    return;
  }

  for (const email of subscribers) {
    const item = document.createElement("li");
    item.textContent = email;
    subscribersList.append(item);
  }
}

function showAnnouncedScreen() {
  checkingScreen.hidden = true;
  announcedScreen.hidden = false;
  document.title = "Results Are Announced";
}
