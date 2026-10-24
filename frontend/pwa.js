// ============================================================
// СВАПТАЙМ — PWA: установка приложения на телефон и в десктоп
// ============================================================
// • регистрирует service worker (офлайн-заглушка + кеш статики);
// • ловит beforeinstallprompt и показывает кнопку «Установить»;
// • на iOS подсказывает путь через «Поделиться → На экран Домой».
// ============================================================

let installEvent = null;
let iosHintShown = false;

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    window.navigator.standalone === true
  );
}

function isIos() {
  const ua = window.navigator.userAgent || "";
  const iosDevice = /iPad|iPhone|iPod/.test(ua);
  const ipadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iosDevice || ipadOs;
}

function showInstallButton(show) {
  const btn = document.getElementById("install-btn");
  if (!btn) return;
  // в standalone-режиме приложение уже установлено — кнопка не нужна
  btn.style.display = show && !isStandalone() ? "" : "none";
}

async function promptInstall() {
  if (isStandalone()) {
    toast("Приложение уже установлено 🎉", "info");
    return;
  }

  if (installEvent) {
    installEvent.prompt();
    try {
      const choice = await installEvent.userChoice;
      if (choice && choice.outcome === "accepted") {
        toast("Устанавливаю СвапТайм…", "success");
      } else {
        toast("Можно установить позже: меню браузера → «Установить приложение»", "info", 4200);
      }
    } catch (err) {}
    installEvent = null;
    showInstallButton(false);
    return;
  }

  if (isIos()) {
    toast("На iPhone: «Поделиться» → «На экран Домой»", "info", 6000);
    return;
  }

  toast("Меню браузера (⋮) → «Установить приложение» или «Добавить на главный экран»", "info", 6000);
}

function initPwa() {
  // кнопка «⬇» в панели профиля вызывает это через data-action="install-app"
  window.__swaptimeInstall = promptInstall;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installEvent = event;
    showInstallButton(true);
  });

  window.addEventListener("appinstalled", () => {
    installEvent = null;
    showInstallButton(false);
    toast("СвапТайм установлен — ищи иконку на главном экране", "success", 4000);
  });

  if (isIos() && !isStandalone() && !iosHintShown) {
    iosHintShown = true;
    showInstallButton(true);
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((registration) => {
          registration.addEventListener("updatefound", () => {
            const worker = registration.installing;
            if (!worker) return;
            worker.addEventListener("statechange", () => {
              if (worker.state === "installed" && navigator.serviceWorker.controller) {
                // новая версия готова — мягко сообщаем
                toast("Доступно обновление — перезапусти приложение", "info", 4000);
              }
            });
          });
        })
        .catch(() => {});
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPwa);
} else {
  initPwa();
}
