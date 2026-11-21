// 웹 푸시(탭을 닫아도 알림). 서버는 내용 없는 푸시만 보내고, 보여 줄 글은 여기서 받아 온다.
// 페이지 요청은 가로채지 않는다(fetch 처리 없음).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = { title: "새 알림", body: "새 알림이 있어요", url: "/" };
      try {
        const response = await fetch("/api/push/latest", { credentials: "same-origin", cache: "no-store" });
        if (response.ok) data = { ...data, ...(await response.json()) };
      } catch (error) {
        // 받지 못하면 내용 없이
      }
      await self.registration.showNotification(String(data.title).slice(0, 80), {
        body: String(data.body).slice(0, 200),
        tag: "mos-notify",
        renotify: true,
        data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
