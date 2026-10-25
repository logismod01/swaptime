// ============================================================
// СВАПТАЙМ — СТРАЖОВКА РАСКЛАДКИ (v13)
// ============================================================
// Зачем это нужно:
//   1) если у человека в кеше остался старый/битый style.css — каркас
//      разваливается: чат-колонка обрезается, сообщения рисуются ниже
//      композера, левая колонка тянется пустой полосой, страница скроллится;
//   2) при масштабе страницы (zoom) `height: 100vh` считается неверно и
//      приложение становится выше окна.
//
// Поэтому здесь:
//   • выкидываем старые кеши service worker'а;
//   • если CSS не применился — один раз перезагружаем style.css с новым URL;
//   • жёстко (inline + !important) задаём геометрию каркаса так, чтобы
//     она была верной при любом CSS и любом масштабе.
// ============================================================

(function () {
    "use strict";

    const CACHE_VERSION = "swaptime-v13";
    const REPAIR_KEY = "swaptime_css_repaired_at";

    // ---------- 1. Убираем старые кеши (даже если активен старый SW) ----------
    function purgeStaleCaches() {
        if (!("caches" in window)) return;
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
            .catch(() => {});
    }

    // ---------- 2. Проверяем, что CSS вообще применился ----------
    function stylesheetApplied() {
        // style.css считается загруженным, если есть его таблица с правилами
        return Array.from(document.styleSheets).some((sheet) => {
            if (!(sheet.href || "").includes("style.css")) return false;
            try {
                return sheet.cssRules.length > 50;
            } catch (e) {
                // style.css наш, свой origin: если правила недоступны —
                // таблица не загрузилась (оборванный запрос / битый кеш)
                return false;
            }
        });
    }

    function shellLooksBroken() {
        if (!document.getElementById("chat-screen")) return false;
        if (!stylesheetApplied()) return true;
        const body = getComputedStyle(document.body);
        const app = document.querySelector("#chat-screen .app");
        const area = document.querySelector("#chat-screen .chat-area");
        if (body.overflowY !== "hidden") return true;
        if (app && getComputedStyle(app).display !== "flex") return true;
        if (area && getComputedStyle(area).overflow !== "hidden") return true;
        return false;
    }

    let repairAttempts = 0;

    function reloadStylesheet() {
        // максимум две попытки за загрузку страницы: каждая новая навигация
        // начинает счёт заново, поэтому «застрять» со старым CSS нельзя
        if (repairAttempts >= 2) return false;
        repairAttempts += 1;
        try {
            sessionStorage.setItem(REPAIR_KEY, String(Date.now()));
        } catch (e) {
            /* приватный режим — не страшно */
        }

        const old = document.querySelector('link[rel="stylesheet"][href*="style.css"]');
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/static/style.css?repair=" + Date.now();
        link.id = "style-css-repair";
        if (old && old.parentNode) {
            old.parentNode.insertBefore(link, old.nextSibling);
        } else {
            document.head.appendChild(link);
        }
        return true;
    }

    // ---------- 3. Жёсткая геометрия каркаса ----------
    function pin(el, props) {
        if (!el) return;
        for (const prop in props) {
            const value = props[prop];
            if (el.style.getPropertyValue(prop) === value && el.style.getPropertyPriority(prop) === "important") {
                continue;
            }
            el.style.setProperty(prop, value, "important");
        }
    }

    function unpin(el, props) {
        if (!el) return;
        props.forEach((prop) => el.style.removeProperty(prop));
    }

    function applyShell() {
        const screen = document.getElementById("chat-screen");
        if (!screen) return;

        const active = screen.classList.contains("active");
        if (!active) {
            unpin(screen, ["position", "inset", "height", "width", "overflow", "min-height"]);
            return;
        }

        const full = {
            position: "fixed",
            inset: "0",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            width: "100%",
            "min-height": "0",
            overflow: "hidden",
        };
        pin(screen, full);

        // высота: fixed + inset:0 обычно уже верные, но при zoom браузер
        // может посчитать каркас выше окна — тогда подгоняем по факту.
        fitToViewport(screen);

        const app = screen.querySelector(".app");
        pin(app, {
            display: "flex",
            height: "100%",
            "max-height": "100%",
            "min-height": "0",
            overflow: "hidden",
        });

        pin(screen.querySelector(".rail"), {
            height: "100%",
            "min-height": "0",
            "overflow-y": "auto",
            "overflow-x": "hidden",
        });

        screen.querySelectorAll(".sidebar, #home-sidebar, #server-sidebar").forEach((side) => {
            pin(side, { height: "100%", "max-height": "100%", "min-height": "0", overflow: "hidden" });
        });

        const area = screen.querySelector(".chat-area");
        pin(area, { height: "100%", "min-height": "0", overflow: "hidden" });
        if (area) {
            area.querySelectorAll(":scope > .view-pane").forEach((pane) => {
                // display панели трогать нельзя — им управляет setView()
                pin(pane, {
                    "flex-direction": "column",
                    "flex-grow": "1",
                    "flex-shrink": "1",
                    "flex-basis": "auto",
                    height: "100%",
                    "min-height": "0",
                    overflow: "hidden",
                });
                pane.querySelectorAll(".chat-active, #chat-active").forEach((chat) => {
                    pin(chat, {
                        "flex-direction": "column",
                        "flex-grow": "1",
                        "flex-shrink": "1",
                        "flex-basis": "auto",
                        height: "100%",
                        "min-height": "0",
                        overflow: "hidden",
                    });
                });
                pin(pane.querySelector(".chat-header"), { "flex-shrink": "0" });
                pin(pane.querySelector(".messages"), {
                    flex: "1 1 auto",
                    "min-height": "0",
                    "overflow-y": "auto",
                });
                pin(pane.querySelector(".chat-input"), { "flex-shrink": "0" });
            });
        }
    }

    // Подгоняем высоту каркаса под реальное окно (страхует от zoom/масштаба)
    function fitToViewport(screen) {
        for (let i = 0; i < 2; i++) {
            const rect = screen.getBoundingClientRect();
            const viewport = window.innerHeight || document.documentElement.clientHeight || 0;
            if (!viewport || !rect.height) return;
            const diff = rect.height - viewport;
            if (Math.abs(diff) <= 1) {
                if (i === 0) screen.style.removeProperty("height");
                return;
            }
            const scale = rect.height / viewport;
            if (!isFinite(scale) || scale <= 0) return;
            const target = Math.round(viewport / scale);
            screen.style.setProperty("height", target + "px", "important");
        }
    }

    let raf = 0;
    let applying = false;
    function schedule() {
        if (raf || applying) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            applying = true;
            try {
                applyShell();
            } finally {
                applying = false;
            }
        });
    }

    // ---------- 4. Запуск ----------
    function boot() {
        purgeStaleCaches();

        const broken = shellLooksBroken();
        document.documentElement.dataset.cssGuard = broken ? "broken" : "ok";
        if (broken) {
            const repaired = reloadStylesheet();
            document.documentElement.dataset.cssRepair = repaired ? "requested" : "skipped";
        }

        applyShell();

        window.addEventListener("resize", schedule, { passive: true });
        window.addEventListener("orientationchange", schedule, { passive: true });
        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", schedule, { passive: true });
        }

        // экран/вид переключается классами — реагируем сразу
        const screen = document.getElementById("chat-screen");
        if (screen && "MutationObserver" in window) {
            const mo = new MutationObserver(() => {
                if (!applying) schedule();
            });
            mo.observe(screen, { attributes: true, attributeFilter: ["class"] });
            screen.querySelectorAll(".view-pane").forEach((pane) => {
                mo.observe(pane, { attributes: true, attributeFilter: ["class"] });
            });
        }

        // перестраховка: после полной загрузки и после отрисовки сообщений
        setTimeout(schedule, 300);
        setTimeout(schedule, 1200);
        setTimeout(schedule, 2500);

        // дешёвый сторож: раз в секунду сверяем высоту каркаса с окном.
        // Ловит масштаб страницы, поворот экрана, открытие devtools — то,
        // из-за чего раньше «уезжала» вся раскладка.
        setInterval(() => {
            const el = document.getElementById("chat-screen");
            if (!el || !el.classList.contains("active") || applying) return;
            const rect = el.getBoundingClientRect();
            const viewport = window.innerHeight || document.documentElement.clientHeight;
            if (viewport && Math.abs(rect.height - viewport) > 1) schedule();
        }, 1000);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
        boot();
    }

    window.SwapLayoutGuard = { apply: applyShell, schedule };
})();
