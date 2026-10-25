/* Owner-only bridgev2 account linking. Mount in an authenticated owner sheet.
 * Existing api() must enforce session+CSRF and return decoded JSON; never
 * expose this controller through agent tools or save provisioning QR data.
 */
(function (global) {
  'use strict';
  // Network glyphs, inline SVG path data only (never fetched at runtime).
  // WhatsApp, Telegram, Instagram, LINE, Signal, KakaoTalk and Messenger: Simple Icons 16.35.0
  // (https://simpleicons.org, npm simple-icons), released under CC0-1.0; see NOTICE.md. The marks remain
  // trademarks of their owners and are shown only to say which network a chat belongs to.
  // Slack uses the CC0 glyph from Simple Icons 10.4.0; other brand glyphs use 16.35.0.
  // Private (Wizard to Wizard) is an original shield-and-lock mark.
  const GLYPH = {
    whatsapp: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z',
    telegram: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
    instagram: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077',
    line: 'M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314',
    signal: 'M12 0q-.934 0-1.83.139l.17 1.111a11 11 0 0 1 3.32 0l.172-1.111A12 12 0 0 0 12 0M9.152.34A12 12 0 0 0 5.77 1.742l.584.961a10.8 10.8 0 0 1 3.066-1.27zm5.696 0-.268 1.094a10.8 10.8 0 0 1 3.066 1.27l.584-.962A12 12 0 0 0 14.848.34M12 2.25a9.75 9.75 0 0 0-8.539 14.459c.074.134.1.292.064.441l-1.013 4.338 4.338-1.013a.62.62 0 0 1 .441.064A9.7 9.7 0 0 0 12 21.75c5.385 0 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25m-7.092.068a12 12 0 0 0-2.59 2.59l.909.664a11 11 0 0 1 2.345-2.345zm14.184 0-.664.909a11 11 0 0 1 2.345 2.345l.909-.664a12 12 0 0 0-2.59-2.59M1.742 5.77A12 12 0 0 0 .34 9.152l1.094.268a10.8 10.8 0 0 1 1.269-3.066zm20.516 0-.961.584a10.8 10.8 0 0 1 1.27 3.066l1.093-.268a12 12 0 0 0-1.402-3.383M.138 10.168A12 12 0 0 0 0 12q0 .934.139 1.83l1.111-.17A11 11 0 0 1 1.125 12q0-.848.125-1.66zm23.723.002-1.111.17q.125.812.125 1.66c0 .848-.042 1.12-.125 1.66l1.111.172a12.1 12.1 0 0 0 0-3.662M1.434 14.58l-1.094.268a12 12 0 0 0 .96 2.591l-.265 1.14 1.096.255.36-1.539-.188-.365a10.8 10.8 0 0 1-.87-2.35m21.133 0a10.8 10.8 0 0 1-1.27 3.067l.962.584a12 12 0 0 0 1.402-3.383zm-1.793 3.848a11 11 0 0 1-2.345 2.345l.664.909a12 12 0 0 0 2.59-2.59zm-19.959 1.1L.357 21.48a1.8 1.8 0 0 0 2.162 2.161l1.954-.455-.256-1.095-1.953.455a.675.675 0 0 1-.81-.81l.454-1.954zm16.832 1.769a10.8 10.8 0 0 1-3.066 1.27l.268 1.093a12 12 0 0 0 3.382-1.402zm-10.94.213-1.54.36.256 1.095 1.139-.266c.814.415 1.683.74 2.591.961l.268-1.094a10.8 10.8 0 0 1-2.35-.869zm3.634 1.24-.172 1.111a12.1 12.1 0 0 0 3.662 0l-.17-1.111q-.812.125-1.66.125a11 11 0 0 1-1.66-.125',
    kakaotalk: 'M22.125 0H1.875C.8394 0 0 .8394 0 1.875v20.25C0 23.1606.8394 24 1.875 24h20.25C23.1606 24 24 23.1606 24 22.125V1.875C24 .8394 23.1606 0 22.125 0zM12 18.75c-.591 0-1.1697-.0413-1.7317-.1209-.5626.3965-3.813 2.6797-4.1198 2.7225 0 0-.1258.0489-.2328-.0141s-.0876-.2282-.0876-.2282c.0322-.2198.8426-3.0183.992-3.5333-2.7452-1.36-4.5701-3.7686-4.5701-6.5135C2.25 6.8168 6.6152 3.375 12 3.375s9.75 3.4418 9.75 7.6875c0 4.2457-4.3652 7.6875-9.75 7.6875zM8.0496 9.8672h-.8777v3.3417c0 .2963-.2523.5372-.5625.5372s-.5625-.2409-.5625-.5372V9.8672h-.8777c-.3044 0-.552-.2471-.552-.5508s.2477-.5508.552-.5508h2.8804c.3044 0 .552.2471.552.5508s-.2477.5508-.552.5508zm10.9879 2.9566a.558.558 0 0 1 .108.4167.5588.5588 0 0 1-.2183.371.5572.5572 0 0 1-.3383.1135.558.558 0 0 1-.4493-.2236l-1.3192-1.7479-.1952.1952v1.2273a.5635.5635 0 0 1-.5627.5628.563.563 0 0 1-.5625-.5625V9.3281c0-.3102.2523-.5625.5625-.5625s.5625.2523.5625.5625v1.209l1.5694-1.5694c.0807-.0807.1916-.1252.312-.1252.1404 0 .2814.0606.3871.1661.0985.0984.1573.2251.1654.3566.0082.1327-.036.2542-.1241.3425l-1.2818 1.2817 1.3845 1.8344zm-8.3502-3.5023c-.095-.2699-.3829-.5475-.7503-.5557-.3663.0083-.6542.2858-.749.5551l-1.3455 3.5415c-.1708.5305-.0217.7272.1333.7988a.8568.8568 0 0 0 .3576.0776c.2346 0 .4139-.0952.4678-.2481l.2787-.7297 1.7152.0001.2785.7292c.0541.1532.2335.2484.4681.2484a.8601.8601 0 0 0 .3576-.0775c.1551-.0713.3041-.2681.1329-.7999l-1.3449-3.5398zm-1.3116 2.4433l.5618-1.5961.5618 1.5961H9.3757zm5.9056 1.3836c0 .2843-.2418.5156-.5391.5156h-1.8047c-.2973 0-.5391-.2314-.5391-.5156V9.3281c0-.3102.2576-.5625.5742-.5625s.5742.2523.5742.5625v3.3047h1.1953c.2974 0 .5392.2314.5392.5156z',
    messenger: 'M12 0C5.24 0 0 4.952 0 11.64c0 3.499 1.434 6.521 3.769 8.61a.96.96 0 0 1 .323.683l.065 2.135a.96.96 0 0 0 1.347.85l2.381-1.053a.96.96 0 0 1 .641-.046A13 13 0 0 0 12 23.28c6.76 0 12-4.952 12-11.64S18.76 0 12 0m6.806 7.44c.522-.03.971.567.63 1.094l-4.178 6.457a.707.707 0 0 1-.977.208l-3.87-2.504a.44.44 0 0 0-.49.007l-4.363 3.01c-.637.438-1.415-.317-.995-.966l4.179-6.457a.706.706 0 0 1 .977-.21l3.87 2.505c.15.097.344.094.491-.007l4.362-3.008a.7.7 0 0 1 .364-.13',
    slack: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
    private: 'M12 .8 2.8 4.4v6.4c0 5.8 3.9 11 9.2 12.4 5.3-1.4 9.2-6.6 9.2-12.4V4.4zM8.4 11.2h7.2v6H8.4zM9.4 11.2V9.4a2.6 2.6 0 0 1 5.2 0v1.8h-1.5V9.4a1.1 1.1 0 0 0-2.2 0v1.8z',
  };
  // Brand colour, readable name and a text fallback per network.
  const BRAND = {
    whatsapp: {color: '#25D366', mark: 'W', label: 'WhatsApp'}, telegram: {color: '#26A5E4', mark: 'T', label: 'Telegram'},
    slack: {color: '#4A154B', mark: 'S', label: 'Slack'}, line: {color: '#06C755', mark: 'L', label: 'LINE'},
    instagram: {color: '#FF0069', mark: 'IG', label: 'Instagram'}, signal: {color: '#3B45FD', mark: 'Si', label: 'Signal'},
    kakaotalk: {color: '#E0B400', mark: 'K', label: 'KakaoTalk'}, messenger: {color: '#0866FF', mark: 'M', label: 'Messenger'},
    private: {color: 'var(--accent)', mark: 'P', label: 'Private'},
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // One brand glyph as an SVG element, coloured through --brand. Null where SVG is unavailable (text fallback).
  function brandIcon(network, cls = '') {
    const d = GLYPH[network], doc = global.document;
    if (!d || !doc || typeof doc.createElementNS !== 'function') return null;
    const svg = doc.createElementNS(SVG_NS, 'svg'), path = doc.createElementNS(SVG_NS, 'path');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'brand-icon' + (cls ? ' ' + cls : '')); svg.dataset.network = network;
    svg.style.setProperty('--brand', (BRAND[network] || {}).color || 'currentColor');
    path.setAttribute('d', d); if (network === 'private') path.setAttribute('fill-rule', 'evenodd');
    svg.append(path); return svg;
  }
  // A round badge: the brand glyph on a light disc, or the text mark when no glyph exists.
  function badge(network, cls = '') {
    const doc = global.document, b = BRAND[network] || {color: '#555', mark: ((network || '?')[0] || '?').toUpperCase(), label: network};
    const el = doc.createElement('span'); el.className = 'net-badge' + (cls ? ' ' + cls : ''); el.dataset.network = network;
    const glyph = brandIcon(network);
    if (glyph) el.append(glyph); else { el.textContent = b.mark; el.classList?.add('text'); el.style.background = b.color; }
    el.title = b.label || network; return el;
  }
  // What linking does for each network, in one line.
  const ABOUT = {
    whatsapp: 'Links like WhatsApp Web. Your phone stays the main device.',
    telegram: 'Links as a new Telegram device.',
    slack: 'Signs in with your work email. Slack emails you a code.',
    line: 'Links as a LINE desktop device. LINE may show a PIN to confirm.',
    instagram: 'Signs in for your Instagram DMs. Instagram may ask you to approve the new login.',
    signal: 'Links as a Signal linked device.',
  };
  // Where the owner scans on the phone.
  const SCAN = {
    whatsapp: ['Open WhatsApp on your phone', 'Tap Settings (iPhone) or ⋮ (Android) → Linked devices', 'Tap Link a device and point your camera here'],
    telegram: ['Open Telegram on your phone', 'Go to Settings → Devices', 'Tap Link Desktop Device and point your camera here'],
    line: ['Open LINE on your phone', 'Tap the QR scanner on the Home tab', 'Scan this code, then confirm on your phone'],
    signal: ['Open Signal on your phone', 'Go to Settings → Linked devices', 'Tap + and point your camera here'],
  };
  const FLOW_LABEL = {
    qr: 'Show QR code', phone: 'Use a pairing code instead', email: 'Sign in with email',
    'dev.highest.matrix.line.qr_login': 'Show QR code', 'dev.highest.matrix.line.email_login': 'Sign in with email & password',
    android: 'Sign in with username & password', 'instagram-password': 'Try the web sign-in instead',
  };
  const STATE = {
    connected: ['Connected', 'on'], disconnected: ['Not connected', 'off'], degraded: ['Needs reconnecting', 'warn'],
    not_configured: ['Needs one-time setup', 'off'], unavailable: ['Bridge offline', 'warn'], unsupported: ['Not available yet', 'off'],
  };
  const isQR = flow => /(^|[._])qr($|[._])/.test(flow.id);
  const SECRET = /password|pass|code|otp|token|cookie|secret|2fa/i;

  global.MessengerConnectors = function (root, api, options = {}) {
    let generation = 0, active = null, providers = [];
    const element = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const request = (network, action, body) => api('/api/unified/connectors/' + network + '/' + action, body === undefined ? 'GET' : 'POST', body);
    const label = network => (providers.find(p => p.network === network) || {}).label || network;
    function mark(network, cls = '') {
      const b = BRAND[network] || {color: '#555', mark: (network[0] || '?').toUpperCase()};
      const glyph = brandIcon(network), m = element('span', 'c-mark' + (cls ? ' ' + cls : '') + (glyph ? ' has-icon' : ''), glyph ? null : b.mark);
      if (glyph) m.append(glyph); else m.style.background = b.color;
      m.setAttribute('aria-hidden', 'true'); return m;
    }
    function problem(e, where = root) {
      for (const old of where.children) if (old.className === 'error c-problem') old.remove();
      const p = element('p', 'error c-problem', (e && e.message) || 'Private bridge unavailable'); p.setAttribute('role', 'alert'); where.append(p);
    }
    function button(parent, text, run, cls = 'secondary wide') {
      const b = element('button', cls, text); b.type = 'button'; parent.append(b);
      b.onclick = async () => { b.disabled = true; try { await run(); } catch (e) { if (root.contains(b)) problem(e); } finally { b.disabled = false; } };
      return b;
    }
    function qrCanvas(data) {
      if (typeof global.qrcode !== 'function') throw new Error('QR renderer unavailable');
      const qr = global.qrcode(0, 'M'); qr.addData(data); qr.make();
      // Render QR modules directly; never insert upstream HTML or open a QR URI.
      const n = qr.getModuleCount(), scale = 8, canvas = element('canvas', 'c-qr'); canvas.width = canvas.height = (n + 8) * scale;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale);
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Login QR code. Scan it with the app on your phone.');
      return canvas;
    }
    function heading(network, title) {
      const head = element('div', 'c-step-head'); head.append(mark(network, 'big'), element('h3', '', title || 'Connect ' + label(network))); return head;
    }
    async function cancel() {
      const old = active; active = null; const mine = ++generation;
      if (old) {
        try { await request(old.network, 'cancel', {login_id: old.login_id}); }
        catch (e) {
          // Already-ended logins need no cleanup; other failures must be visible.
          if (!['login_expired', 'invalid_step', 'login_cancelled'].includes(e.code)) {
            if (mine === generation) active = old;
            throw e;
          }
        }
      }
    }
    async function start(network, flow) {
      const mine = generation + 1;
      await cancel(); if (mine !== generation) return;
      root.replaceChildren(heading(network), element('p', 'helper', 'Starting…'));
      try {
        const result = await request(network, 'start', {flow});
        if (mine !== generation) {
          // Close may happen before start returns a process ID. Cancel that exact
          // orphan, never the newer controller's login.
          if (result.login_id && result.type !== 'complete') await request(network, 'cancel', {login_id: result.login_id});
          return;
        }
        await step(network, flow, result, mine);
      } catch (e) { if (mine !== generation) return; failure(e, network, flow, mine); }
    }
    function failure(error, network, flow, mine) {
      if (mine !== generation) return;
      problem(error);
      button(root, 'Start again', async () => start(network, flow), 'primary wide');
      button(root, 'Back to accounts', async () => show());
    }
    async function advance(network, payload, fields, mine) {
      let result = await request(network, 'step', {...payload, fields});
      while (result.type === 'pending' && mine === generation) {
        await new Promise(resolve => global.setTimeout(resolve, 1000));
        if (mine !== generation) return null;
        // Poll the local worker. Never replay passwords or email/MFA codes.
        result = await request(network, 'step', {...payload, fields: {}});
      }
      return result;
    }
    async function step(network, flow, result, mine) {
      if (mine !== generation || !result) return;
      if (result.type === 'complete') {
        active = null;
        root.replaceChildren(heading(network, label(network) + ' connected'),
          element('p', 'helper', 'Your chats appear in the Inbox over the next few minutes. Older history fills in gradually.'));
        button(root, 'Done', async () => show(), 'primary wide');
        options.onChange?.(network);
        return;
      }
      active = {network, login_id: result.login_id};
      const payload = () => ({login_id: result.login_id, step_id: result.step_id, type: result.type, txn_id: result.txn_id});
      root.replaceChildren(heading(network));
      const back = () => button(root, 'Cancel', async () => {
        const nextGeneration = generation + 1;
        await cancel(); if (nextGeneration === generation) await show();
      });
      if (result.type === 'display_and_wait') {
        const params = result.display_and_wait || {};
        if (params.type === 'qr') {
          const steps = SCAN[network];
          if (steps) { const ol = element('ol', 'c-howto'); for (const s of steps) ol.append(element('li', '', s)); root.append(ol); }
          else if (result.instructions) root.append(element('p', 'helper', result.instructions));
          const frame = element('div', 'c-qr-frame'); frame.append(qrCanvas(params.data)); root.append(frame);
        } else if (params.type === 'code' || params.type === 'emoji') {
          root.append(element('p', 'helper', result.instructions || 'Enter this code on your phone.'), element('p', 'c-code', params.data));
        } else if (params.type === 'nothing') {
          root.append(element('p', 'helper', result.instructions || 'Approve the login in the app on your phone.'));
        } else throw new Error('Unsupported login display type');
        const wait = element('p', 'c-waiting'); wait.append(element('span', 'spinner'), element('span', '', 'Waiting for your phone…'));
        root.append(wait); back();
        // The bridge answers once the phone acts, or with a refreshed code, so wait while this owner
        // screen is open. Closing the sheet bumps the generation and cancels the login.
        let next;
        try { next = await advance(network, payload(), {}, mine); }
        catch (e) {
          if (mine !== generation) return;
          wait.replaceChildren(element('span', '', 'Login has stopped waiting.'));
          failure(e, network, flow, mine);
          return;
        }
        await step(network, flow, next, mine);
      } else if (result.type === 'challenge') {
        root.append(element('p', 'helper', label(network) + ' requires browser verification (such as a CAPTCHA or checkpoint). This view cannot safely complete it. Finish verification in the official app or website, then start a new login. Completing it elsewhere may not resume this bridge session.'));
        button(root, 'Start again', async () => start(network, flow), 'primary wide'); back();
      } else if (result.type === 'user_input') {
        if (result.instructions) root.append(element('p', 'helper', result.instructions));
        const form = element('form', 'c-form'), inputs = {}; form.autocomplete = 'off';
        for (const field of (result.user_input || {}).fields || []) {
          const wrap = element('label', '', field.name || field.id);
          const input = element(field.type === 'select' ? 'select' : 'input'); input.name = field.id;
          if (field.type === 'select') for (const value of field.options || []) { const option = element('option', '', value); option.value = value; input.append(option); }
          else {
            // Passwords, codes and tokens stay masked; emails, usernames and phone numbers stay readable.
            const kind = (field.type || '') + ' ' + (field.id || '');
            input.type = SECRET.test(kind) ? 'password' : /phone/.test(kind) ? 'tel' : /email/.test(kind) ? 'email' : 'text';
            input.autocapitalize = 'none'; input.spellcheck = false;
            if (field.description) input.placeholder = field.description;
          }
          input.autocomplete = 'off'; input.required = !field.optional;
          if (field.default_value != null && !SECRET.test((field.type || '') + ' ' + field.id)) input.value = field.default_value;
          if (field.min_length) input.minLength = field.min_length;
          if (field.max_length) input.maxLength = field.max_length;
          wrap.append(input); form.append(wrap); inputs[field.id] = input;
        }
        const submit = element('button', 'primary wide', 'Continue'); submit.type = 'submit'; form.append(submit); root.append(form); back();
        global.requestAnimationFrame?.(() => Object.values(inputs)[0]?.focus?.());
        form.onsubmit = async e => {
          e.preventDefault(); if (submit.disabled || mine !== generation) return; submit.disabled = true;
          submit.textContent = 'Waiting for bridge…';
          const fields = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]));
          for (const input of Object.values(inputs)) input.value = '';
          try { await step(network, flow, await advance(network, payload(), fields, mine), mine); }
          catch (err) {
            if (mine !== generation) return;
            // A returned user_input step is the upstream's recoverable retry.
            // A thrown error is fatal/ambiguous: never resubmit stale credentials.
            failure(err, network, flow, mine);
          } finally { for (const key of Object.keys(fields)) delete fields[key]; }
        };
      } else throw new Error('Unsupported login step');
    }
    async function setupTelegram() {
      const mine = generation + 1;
      await cancel(); if (mine !== generation) return;
      root.replaceChildren(heading('telegram', 'Set up Telegram'));
      root.append(element('p', 'helper', 'Add your Telegram application keys once. Then connect your account by scanning a QR code with Telegram on your phone. These are app keys, not your Telegram login code.'));
      const link = element('a', '', 'Get application keys at my.telegram.org/apps');
      link.href = 'https://my.telegram.org/apps'; link.target = '_blank'; link.rel = 'noopener noreferrer'; root.append(link);
      const form = element('form', 'c-form'); form.autocomplete = 'off';
      const idLabel = element('label', '', 'API ID'), id = element('input');
      id.name = 'api_id'; id.type = 'text'; id.inputMode = 'numeric'; id.required = true; id.autocomplete = 'off'; idLabel.append(id);
      const hashLabel = element('label', '', 'API hash'), hash = element('input');
      hash.name = 'api_hash'; hash.type = 'password'; hash.required = true; hash.autocomplete = 'off'; hashLabel.append(hash);
      const save = element('button', 'primary wide', 'Save application keys'); save.type = 'submit'; form.append(idLabel, hashLabel, save); root.append(form);
      button(root, 'Back to accounts', async () => show());
      form.onsubmit = async e => {
        e.preventDefault(); if (save.disabled || mine !== generation) return;
        save.disabled = true;
        const payload = {api_id: id.value, api_hash: hash.value}; hash.value = '';
        try {
          const result = await api('/api/view/telegram/application', 'POST', payload);
          if (mine !== generation) return;
          if (result.configured !== true) throw new Error('Telegram application setup did not complete. Try again.');
          root.replaceChildren(heading('telegram', 'Telegram application configured'), element('p', 'helper', 'Telegram is warming up. Wait a moment, then refresh accounts. When the QR option appears, click it to connect your phone.'));
          button(root, 'Refresh accounts', async () => show(), 'primary wide');
        } catch (_) {
          // Setup errors must not reflect the submitted hash or other server text.
          if (mine === generation) problem(new Error('Could not save Telegram application keys. Check the API ID and hash from my.telegram.org/apps, then try again.'), form);
        } finally { payload.api_hash = ''; save.disabled = false; }
      };
    }
    function card(provider) {
      const [stateText, tone] = STATE[provider.state] || [provider.state, 'off'];
      const section = element('section', 'c-card ' + tone); section.dataset.network = provider.network;
      const top = element('div', 'c-card-top'); top.append(mark(provider.network));
      const text = element('div', 'c-card-text'); text.append(element('strong', '', provider.label), element('span', 'c-pill ' + tone, stateText));
      top.append(text); section.append(top);
      const flows = provider.flows || [];
      if (provider.state === 'connected') {
        const who = (provider.logins || []).map(l => l.name).filter(Boolean).join(', ');
        if (who) section.append(element('p', 'helper', who));
        button(section, 'Disconnect', async () => {
          if (global.confirm && !global.confirm('Disconnect ' + provider.label + '? Its chats leave this Messenger. Nothing changes on ' + provider.label + ' itself.')) return;
          await request(provider.network, 'disconnect', {}); await show(); options.onChange?.(provider.network);
        }, 'c-link danger').setAttribute('aria-label', 'Disconnect ' + provider.label);
        return section;
      }
      if (ABOUT[provider.network] && flows.length) section.append(element('p', 'helper', ABOUT[provider.network]));
      if (provider.state === 'not_configured' && provider.network === 'telegram') {
        section.append(element('p', 'helper', 'Add Telegram application keys once, then scan a QR code with your phone.'));
        button(section, 'Set up Telegram', setupTelegram, 'primary wide');
      }
      else if (provider.state === 'unavailable') section.append(element('p', 'helper', 'The private bridge is not responding. Try again in a minute.'));
      [...flows].sort((a, b) => isQR(b) - isQR(a)).forEach((flow, i) => {
        const name = FLOW_LABEL[flow.id] || flow.name;
        button(section, name, async () => start(provider.network, flow.id), i === 0 ? 'primary wide' : 'c-link').setAttribute('aria-label', name + ' for ' + provider.label);
      });
      return section;
    }
    async function show({focus} = {}) {
      const mine = generation + 1;
      await cancel(); if (mine !== generation) return;
      const data = await api('/api/unified/connectors', 'GET'); if (mine !== generation) return;
      providers = data.providers || [];
      // Signal and KakaoTalk are optional on this Wizard; they fold away until set up.
      const usable = providers.filter(p => p.network === 'telegram' || (p.supported && p.state !== 'not_configured'));
      const later = providers.filter(p => !usable.includes(p));
      const connected = usable.filter(p => p.state === 'connected');
      root.replaceChildren(element('p', 'c-summary', connected.length ? connected.length + ' of ' + usable.length + ' accounts connected' : 'Connect an account to bring its chats into your Inbox'));
      const order = p => p.state === 'connected' ? 2 : p.state === 'not_configured' ? 1 : 0;
      for (const provider of [...usable].sort((a, b) => order(a) - order(b))) root.append(card(provider));
      if (later.length) {
        const more = element('details', 'c-later'); more.append(element('summary', '', 'More networks'));
        for (const p of later) { const row = element('p', 'c-later-row'); row.append(mark(p.network, 'small'), element('span', '', p.label + ' · ' + (STATE[p.state] || [p.state])[0])); more.append(row); }
        root.append(more);
      }
      if (focus) root.querySelector('[data-network="' + focus + '"] .primary')?.focus();
      return providers;
    }
    return {show, start, close: async () => { root.replaceChildren(); await cancel(); }};
  };
  global.MessengerConnectors.BRAND = BRAND;
  global.MessengerConnectors.brandIcon = brandIcon;
  global.MessengerConnectors.badge = badge;
})(window);
