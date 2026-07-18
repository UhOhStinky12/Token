// Live Token Meter for SillyTavern
// -----------------------------------------------------------------------
// Tracks per-chat token usage (prompt / completion / total) and shows a
// live "current context vs. max context" meter.
//
// Design note: SillyTavern's public extension API does not give reliable,
// version-stable access to a backend's raw `usage` object (prompt_tokens /
// completion_tokens as reported by e.g. LM Studio). That's internal wiring
// that changes between ST releases and between backends. Instead, this
// extension uses SillyTavern's own tokenizer and its own bookkeeping:
//   - `generate_interceptor` (declared in manifest.json) is called by ST
//     right before every real generation and hands us the exact
//     `contextSize` (in tokens) that is about to be sent to the model.
//     That's as close to "ground truth" as an extension can get, and it
//     works identically no matter which backend you're using.
//   - `getTokenCountAsync()` (from getContext()) is the same tokenizer ST
//     itself uses to budget the prompt, so counting the current chat with
//     it gives an accurate live estimate between generations, including
//     as you type in the input box.
// -----------------------------------------------------------------------

const MODULE_NAME = 'live_token_meter';

const defaultSettings = Object.freeze({
    enabled: true,
    showFloatingWidget: true,
    warnThreshold: 0.75,
    dangerThreshold: 0.9,
    widgetX: null,
    widgetY: null,
});

// -------------------------------------------------------------------------
// Settings helpers
// -------------------------------------------------------------------------

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    saveSettingsDebounced();
}

// -------------------------------------------------------------------------
// Per-chat stats (stored in chat metadata, so they travel with the chat
// file and survive reloads / exports of the chat itself)
// -------------------------------------------------------------------------

const defaultChatStats = () => ({
    promptTokens: 0,
    completionTokens: 0,
    lastPrompt: 0,
    lastCompletion: 0,
    lastBudget: 0,
    messagesCounted: 0,
});

function getChatStats() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = defaultChatStats();
    }
    return chatMetadata[MODULE_NAME];
}

let saveMetaTimer = null;
function saveChatStatsDebounced() {
    clearTimeout(saveMetaTimer);
    saveMetaTimer = setTimeout(async () => {
        try {
            const { saveMetadata } = SillyTavern.getContext();
            await saveMetadata();
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to save chat metadata`, err);
        }
    }, 800);
}

// -------------------------------------------------------------------------
// Small utils
// -------------------------------------------------------------------------

function debounce(fn, wait) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}

function formatNumber(n) {
    if (!Number.isFinite(n)) return '0';
    return Math.round(n).toLocaleString();
}

function formatCompact(n) {
    if (!Number.isFinite(n)) return '0';
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
}

// -------------------------------------------------------------------------
// Live context estimate (chat history + current draft, vs. max context)
// -------------------------------------------------------------------------

let liveContextCache = { used: 0, max: 0 };

async function computeLiveContext() {
    const { chat, getTokenCountAsync, maxContext } = SillyTavern.getContext();
    let used = 0;
    try {
        for (const mes of chat) {
            if (!mes || typeof mes.mes !== 'string' || !mes.mes) continue;
            used += await getTokenCountAsync(mes.mes);
        }
        const draft = document.getElementById('send_textarea')?.value ?? '';
        if (draft) {
            used += await getTokenCountAsync(draft);
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed computing live context`, err);
    }
    liveContextCache = { used, max: Number(maxContext) || 0 };
    return liveContextCache;
}

// -------------------------------------------------------------------------
// UI construction
// -------------------------------------------------------------------------

function buildSettingsPanelHtml() {
    return `
    <div id="ltm-settings" class="ltm-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Live Token Meter</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="ltm-enabled" type="checkbox" />
                    <span>Enable Live Token Meter</span>
                </label>
                <label class="checkbox_label">
                    <input id="ltm-floating" type="checkbox" />
                    <span>Show floating widget</span>
                </label>

                <div class="ltm-row">
                    <label for="ltm-warn">Warn color at</label>
                    <input id="ltm-warn" type="number" min="10" max="99" step="1" class="text_pole ltm-num" />
                    <span>%</span>
                </div>
                <div class="ltm-row">
                    <label for="ltm-danger">Danger color at</label>
                    <input id="ltm-danger" type="number" min="10" max="99" step="1" class="text_pole ltm-num" />
                    <span>%</span>
                </div>

                <hr>

                <div class="ltm-section-title">Current Chat</div>
                <table class="ltm-table">
                    <tr><td>Chat-history tokens sent</td><td id="ltm-panel-prompt">0</td></tr>
                    <tr><td>Response tokens received</td><td id="ltm-panel-completion">0</td></tr>
                    <tr><td>Total</td><td id="ltm-panel-total">0</td></tr>
                </table>

                <div class="ltm-section-title">Last Request</div>
                <table class="ltm-table">
                    <tr><td>Chat history</td><td id="ltm-panel-last-prompt">0</td></tr>
                    <tr><td>Response</td><td id="ltm-panel-last-completion">0</td></tr>
                    <tr><td>Context budget available</td><td id="ltm-panel-last-budget">0</td></tr>
                </table>
                <div class="ltm-note">
                    "Chat history" only counts the visible chat messages, not character card,
                    persona, or world info tokens - SillyTavern doesn't expose those to
                    extensions. For the exact full breakdown, use SillyTavern's own
                    <b>Prompt Itemization</b> (the ⓘ icon on a message).
                </div>

                <div class="ltm-section-title">Current Context (live estimate)</div>
                <div class="ltm-bar-outer">
                    <div id="ltm-panel-bar-fill" class="ltm-bar-fill"></div>
                </div>
                <div id="ltm-panel-context-label" class="ltm-context-label">0 / 0 (0%)</div>

                <div class="ltm-buttons">
                    <button id="ltm-reset" class="menu_button">Reset Chat Statistics</button>
                    <button id="ltm-export" class="menu_button">Export</button>
                    <button id="ltm-import" class="menu_button">Import</button>
                    <button id="ltm-recreate-widget" class="menu_button">Fix / Recreate Widget</button>
                    <input id="ltm-import-file" type="file" accept="application/json" style="display:none" />
                </div>
            </div>
        </div>
    </div>`;
}

function buildFloatingWidgetHtml() {
    return `
    <div id="ltm-widget" class="ltm-widget">
        <div id="ltm-widget-drag" class="ltm-widget-header">
            <span>🧠</span>
            <span id="ltm-widget-total">0</span>
        </div>
        <div class="ltm-bar-outer ltm-bar-outer-small">
            <div id="ltm-widget-bar-fill" class="ltm-bar-fill"></div>
        </div>
        <div id="ltm-widget-label" class="ltm-widget-label">0 / 0</div>
    </div>`;
}

function injectUiOnce() {
    if (!document.getElementById('ltm-settings')) {
        const container = document.getElementById('extensions_settings2')
            || document.getElementById('extensions_settings');
        if (container) {
            container.insertAdjacentHTML('beforeend', buildSettingsPanelHtml());
            wireSettingsPanel();
        } else {
            console.warn(`[${MODULE_NAME}] Could not find #extensions_settings2 or #extensions_settings - settings panel not injected.`);
        }
    }
    if (!document.getElementById('ltm-widget')) {
        document.body.insertAdjacentHTML('beforeend', buildFloatingWidgetHtml());
        wireFloatingWidget();
        const el = document.getElementById('ltm-widget');
        console.log(`[${MODULE_NAME}] Floating widget injected:`, !!el, el ? el.getBoundingClientRect() : null);
    }
}

function wireSettingsPanel() {
    const settings = getSettings();

    const enabledEl = document.getElementById('ltm-enabled');
    const floatingEl = document.getElementById('ltm-floating');
    const warnEl = document.getElementById('ltm-warn');
    const dangerEl = document.getElementById('ltm-danger');

    enabledEl.checked = settings.enabled;
    floatingEl.checked = settings.showFloatingWidget;
    warnEl.value = Math.round(settings.warnThreshold * 100);
    dangerEl.value = Math.round(settings.dangerThreshold * 100);

    enabledEl.addEventListener('change', () => {
        settings.enabled = enabledEl.checked;
        saveSettings();
        applyEnabledState();
    });

    floatingEl.addEventListener('change', () => {
        settings.showFloatingWidget = floatingEl.checked;
        saveSettings();
        applyEnabledState();
    });

    warnEl.addEventListener('change', () => {
        const v = Math.min(99, Math.max(1, Number(warnEl.value) || 75));
        settings.warnThreshold = v / 100;
        saveSettings();
        refreshUI();
    });

    dangerEl.addEventListener('change', () => {
        const v = Math.min(99, Math.max(1, Number(dangerEl.value) || 90));
        settings.dangerThreshold = v / 100;
        saveSettings();
        refreshUI();
    });

    document.getElementById('ltm-reset').addEventListener('click', async () => {
        const { Popup } = SillyTavern.getContext();
        const confirmed = await Popup.show.confirm(
            'Reset Chat Statistics',
            'This clears the token totals for THIS chat only. Continue?',
        );
        if (!confirmed) return;
        const { chatMetadata } = SillyTavern.getContext();
        chatMetadata[MODULE_NAME] = defaultChatStats();
        saveChatStatsDebounced();
        refreshUI();
        toastr.success('Chat token statistics reset.');
    });

    document.getElementById('ltm-export').addEventListener('click', () => {
        const stats = getChatStats();
        const blob = new Blob([JSON.stringify(stats, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'live-token-meter-stats.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    });

    document.getElementById('ltm-import').addEventListener('click', () => {
        document.getElementById('ltm-import-file').click();
    });

    document.getElementById('ltm-import-file').addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = '';
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            const stats = getChatStats();
            stats.promptTokens = Number(data.promptTokens) || 0;
            stats.completionTokens = Number(data.completionTokens) || 0;
            stats.lastPrompt = Number(data.lastPrompt) || 0;
            stats.lastCompletion = Number(data.lastCompletion) || 0;
            stats.lastBudget = Number(data.lastBudget) || 0;
            saveChatStatsDebounced();
            refreshUI();
            toastr.success('Statistics imported.');
        } catch (err) {
            console.error(`[${MODULE_NAME}] Import failed`, err);
            toastr.error('Could not import that file - is it valid JSON?');
        }
    });

    document.getElementById('ltm-recreate-widget').addEventListener('click', () => {
        const existing = document.getElementById('ltm-widget');
        if (existing) existing.remove();
        const settings2 = getSettings();
        settings2.showFloatingWidget = true;
        settings2.widgetX = null;
        settings2.widgetY = null;
        saveSettings();
        document.getElementById('ltm-floating').checked = true;
        document.body.insertAdjacentHTML('beforeend', buildFloatingWidgetHtml());
        wireFloatingWidget();
        applyEnabledState();
        refreshUI();
        toastr.info('Widget recreated at the default position (bottom-right).');
        console.log(`[${MODULE_NAME}] Widget recreated. If you still don't see it, check the browser console (F12) for errors and report them.`);
    });
}

function wireFloatingWidget() {
    const widget = document.getElementById('ltm-widget');
    const handle = document.getElementById('ltm-widget-drag');
    const settings = getSettings();

    if (typeof settings.widgetX === 'number' && typeof settings.widgetY === 'number') {
        widget.style.left = `${settings.widgetX}px`;
        widget.style.top = `${settings.widgetY}px`;
        widget.style.right = 'auto';
        widget.style.bottom = 'auto';
    }

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onPointerDown = (e) => {
        dragging = true;
        const rect = widget.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        widget.classList.add('ltm-dragging');
    };

    const onPointerMove = (e) => {
        if (!dragging) return;
        const x = Math.min(Math.max(0, e.clientX - offsetX), window.innerWidth - widget.offsetWidth);
        const y = Math.min(Math.max(0, e.clientY - offsetY), window.innerHeight - widget.offsetHeight);
        widget.style.left = `${x}px`;
        widget.style.top = `${y}px`;
        widget.style.right = 'auto';
        widget.style.bottom = 'auto';
    };

    const onPointerUp = () => {
        if (!dragging) return;
        dragging = false;
        widget.classList.remove('ltm-dragging');
        const rect = widget.getBoundingClientRect();
        const s = getSettings();
        s.widgetX = rect.left;
        s.widgetY = rect.top;
        saveSettings();
    };

    handle.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
}

function applyEnabledState() {
    const settings = getSettings();
    const panel = document.getElementById('ltm-settings');
    const widget = document.getElementById('ltm-widget');
    if (panel) panel.style.display = settings.enabled ? '' : 'none';
    if (widget) widget.style.display = (settings.enabled && settings.showFloatingWidget) ? '' : 'none';
}

function thresholdClass(ratio, settings) {
    if (ratio >= settings.dangerThreshold) return 'ltm-danger';
    if (ratio >= settings.warnThreshold) return 'ltm-warn';
    return 'ltm-ok';
}

// -------------------------------------------------------------------------
// UI refresh
// -------------------------------------------------------------------------

async function refreshUI() {
    const settings = getSettings();
    if (!settings.enabled) return;

    const stats = getChatStats();
    const { used, max } = await computeLiveContext();
    const ratio = max > 0 ? Math.min(1, used / max) : 0;
    const cls = thresholdClass(ratio, settings);

    // Settings panel
    const panelPrompt = document.getElementById('ltm-panel-prompt');
    if (panelPrompt) {
        document.getElementById('ltm-panel-prompt').textContent = formatNumber(stats.promptTokens);
        document.getElementById('ltm-panel-completion').textContent = formatNumber(stats.completionTokens);
        document.getElementById('ltm-panel-total').textContent = formatNumber(stats.promptTokens + stats.completionTokens);
        document.getElementById('ltm-panel-last-prompt').textContent = formatNumber(stats.lastPrompt);
        document.getElementById('ltm-panel-last-completion').textContent = formatNumber(stats.lastCompletion);
        document.getElementById('ltm-panel-last-budget').textContent = formatNumber(stats.lastBudget);

        const fill = document.getElementById('ltm-panel-bar-fill');
        fill.style.width = `${Math.round(ratio * 100)}%`;
        fill.className = `ltm-bar-fill ${cls}`;
        document.getElementById('ltm-panel-context-label').textContent =
            `${formatNumber(used)} / ${formatNumber(max)} (${Math.round(ratio * 100)}%)`;
    }

    // Floating widget
    const widgetTotal = document.getElementById('ltm-widget-total');
    if (widgetTotal) {
        widgetTotal.textContent = formatCompact(stats.promptTokens + stats.completionTokens);
        const fill = document.getElementById('ltm-widget-bar-fill');
        fill.style.width = `${Math.round(ratio * 100)}%`;
        fill.className = `ltm-bar-fill ${cls}`;
        document.getElementById('ltm-widget-label').textContent =
            `${formatCompact(used)} / ${formatCompact(max)}`;
    }

    applyEnabledState();
}

const refreshUIDebounced = debounce(refreshUI, 250);

// -------------------------------------------------------------------------
// Event wiring
// -------------------------------------------------------------------------

async function onMessageReceived(messageId) {
    try {
        const { chat, getTokenCountAsync } = SillyTavern.getContext();
        const message = (typeof messageId === 'number' && chat[messageId]) ? chat[messageId] : chat[chat.length - 1];
        if (!message || message.is_user || message.is_system) return;
        if (typeof message.mes !== 'string') return;

        const tokens = await getTokenCountAsync(message.mes);
        const stats = getChatStats();
        stats.lastCompletion = tokens;
        stats.completionTokens += tokens;
        stats.messagesCounted += 1;
        saveChatStatsDebounced();
    } catch (err) {
        console.error(`[${MODULE_NAME}] onMessageReceived failed`, err);
    } finally {
        refreshUIDebounced();
    }
}

function onChatChanged() {
    // chatMetadata reference changes on chat switch - just re-read it fresh.
    refreshUIDebounced();
}

function registerEvents() {
    const { eventSource, eventTypes: event_types } = SillyTavern.getContext();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_SENT, refreshUIDebounced);
    eventSource.on(event_types.MESSAGE_DELETED, refreshUIDebounced);
    eventSource.on(event_types.MESSAGE_EDITED, refreshUIDebounced);
    eventSource.on(event_types.MESSAGE_SWIPED, refreshUIDebounced);
    eventSource.on(event_types.GENERATION_ENDED, refreshUIDebounced);
    eventSource.on(event_types.GENERATION_STOPPED, refreshUIDebounced);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Anything that can change the effective max context needs to trigger
    // a refresh too, or the live meter's denominator goes stale until the
    // next message. Not all of these exist on every ST version, so guard
    // each one individually instead of letting one bad key break the rest.
    const contextAffectingEvents = [
        'SETTINGS_UPDATED',
        'MAIN_API_CHANGED',
        'CHATCOMPLETION_SOURCE_CHANGED',
        'CHATCOMPLETION_MODEL_CHANGED',
        'PRESET_CHANGED',
        'CONNECTION_PROFILE_LOADED',
        'ONLINE_STATUS_CHANGED',
    ];
    for (const key of contextAffectingEvents) {
        if (event_types[key]) {
            eventSource.on(event_types[key], refreshUIDebounced);
        }
    }

    const textarea = document.getElementById('send_textarea');
    if (textarea) {
        textarea.addEventListener('input', debounce(refreshUI, 400));
    }

    // Safety net: settings changes don't always emit an event we can catch
    // (or the id/selector changes between ST versions). Re-check every few
    // seconds so the meter can't drift far out of sync. getTokenCountAsync
    // is cached internally so this stays cheap.
    setInterval(() => refreshUI(), 5000);
}

// -------------------------------------------------------------------------
// Generation interceptor - fires right before every real generation.
//
// IMPORTANT: `contextSize` here is NOT the number of tokens actually used
// in the prompt. It's the token BUDGET SillyTavern computed for this
// generation (roughly Context Size - Response Length) - a ceiling, not a
// measurement. You can confirm this yourself: it matches the "Max Context
// (Context Size - Response Length)" line in ST's own Prompt Itemization
// popup exactly, not the "Total Tokens in Prompt" line above it.
//
// So instead we tokenize the `chat` array the interceptor gives us, which
// is the actual finalized list of chat-history messages about to be used
// for prompt building. That's a real measurement, not a budget - it just
// doesn't include character card / persona / world info tokens (ST folds
// those in later, in a step extensions don't get a stable hook into). We
// show both numbers and label them honestly rather than pretend they're
// the same thing.
// -------------------------------------------------------------------------

globalThis.LiveTokenMeter_interceptor = async function (chat, contextSize /*, abort, type */) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;
        const { getTokenCountAsync } = SillyTavern.getContext();

        let historyTokens = 0;
        for (const mes of chat) {
            if (!mes || typeof mes.mes !== 'string' || !mes.mes) continue;
            historyTokens += await getTokenCountAsync(mes.mes);
        }

        const stats = getChatStats();
        stats.lastPrompt = historyTokens;
        stats.lastBudget = Number(contextSize) || 0;
        stats.promptTokens += historyTokens;
        saveChatStatsDebounced();
    } catch (err) {
        console.error(`[${MODULE_NAME}] interceptor failed`, err);
    } finally {
        refreshUIDebounced();
    }
};

// -------------------------------------------------------------------------
// Bootstrap
// -------------------------------------------------------------------------

function init() {
    try {
        console.log(`[${MODULE_NAME}] Initializing...`);
        getSettings();
        injectUiOnce();
        applyEnabledState();
        registerEvents();
        refreshUI();
        console.log(`[${MODULE_NAME}] Init complete.`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] Init failed:`, err);
    }
}

jQuery(() => {
    // APP_READY auto-fires for listeners attached after the app is ready,
    // so this works whether the extension loads before or after that point.
    const { eventSource, eventTypes: event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, init);
});
