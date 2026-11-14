// La página de entrada y autorización de EditorMax. Supabase manda aquí con ?authorization_id=…; si no hay sesión se pide el correo. El enlace del
// correo vuelve a esta misma página con la sesión detrás de «#» y con la autorización en la dirección, y aquí se retoma, en el navegador que sea.
// Si el correo trae un código, también se puede escribir. El destino se comprueba siempre: el nombre lo declara el cliente, el host no se puede fingir.
(() => {
  const CFG = window.EM_CONFIG ?? {};
  const CLAVE = "editormax:autorizacion";
  // lo que vive una autorización en Supabase (medido el 10/11: 600 s)
  const TTL = 10 * 60_000;
  const ID_VALIDO = /^[A-Za-z0-9_-]{8,128}$/;
  const $ = (id) => document.getElementById(id);
  const PANTALLAS = ["cargando", "correo", "enviado", "autorizar", "listo", "otra", "error"];
  const ver = (p) => PANTALLAS.forEach((x) => { $(x).hidden = x !== p; });
  const fallo = (m) => { $("error-texto").textContent = m; ver("error"); };
  const GASTADO = "Ese enlace ya se ha usado o ha caducado. Pide otro.";

  const guardar = (id) => { try { localStorage.setItem(CLAVE, JSON.stringify({ id, t: Date.now() })); } catch { /* sin almacenamiento: la autorización viaja en el enlace */ } };
  const olvidar = () => { try { localStorage.removeItem(CLAVE); } catch { /* nada */ } };
  const pendiente = () => {
    try {
      const { id, t } = JSON.parse(localStorage.getItem(CLAVE) ?? "{}");
      return typeof t === "number" && Date.now() - t < TTL && ID_VALIDO.test(id ?? "") ? id : null;
    } catch { return null; }
  };

  // El correo que se pidió desde este navegador, mientras vale su enlace (1 hora). Una sesión que llega en un enlace solo se queda aquí si es la de ese
  // correo: así un enlace con la sesión de otro (uno que no ha mandado EditorMax) no deja a nadie dentro de una cuenta que no pidió.
  const PEDIDO = "editormax:correo-pedido";
  const TTL_PEDIDO = 60 * 60_000;
  const apuntarPedido = (email) => { try { localStorage.setItem(PEDIDO, JSON.stringify({ email: email.toLowerCase(), t: Date.now() })); } catch { /* sin almacenamiento: el enlace pedirá confirmar la cuenta */ } };
  const olvidarPedido = () => { try { localStorage.removeItem(PEDIDO); } catch { /* nada */ } };
  const pedido = () => {
    try {
      const { email, t } = JSON.parse(localStorage.getItem(PEDIDO) ?? "{}");
      return typeof t === "number" && Date.now() - t < TTL_PEDIDO && typeof email === "string" && email ? email : null;
    } catch { return null; }
  };

  // Lo que trae el enlace del correo, detrás de «#»: la sesión, o el aviso de que ya no vale. Se lee y se quita de la barra y del historial antes de nada.
  function delEnlace() {
    const f = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    const acceso = f.get("access_token"), refresco = f.get("refresh_token");
    if (acceso && refresco) return { acceso, refresco };
    return f.get("error") || f.get("error_code") ? { gastado: true } : null;
  }

  const esLocal = (h) => h === "localhost" || h === "::1" || h === "[::1]" || /^127(\.\d{1,3}){3}$/.test(h);
  // Claude, cuando EditorMax se conecta como conector desde la app (Personalizar › Conectores): la vuelta es a su propia dirección, y solo a esa ruta
  // (https://claude.com/docs/connectors/building/authentication: «https://claude.ai/api/mcp/auth_callback»)
  const esClaude = (u) => u.protocol === "https:" && (u.host === "claude.ai" || u.host === "claude.com") && u.pathname === "/api/mcp/auth_callback" && !u.username && !u.password;
  // solo se vuelve a una web por HTTPS o a este ordenador
  function destino(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol === "https:") return { host: u.host, local: esLocal(u.hostname), claude: esClaude(u) };
    if (u.protocol === "http:" && esLocal(u.hostname)) return { host: u.host, local: true, claude: false };
    return null;
  }
  // EditorMax se conecta de dos maneras: desde la app de Claude (vuelve a Claude) o desde Claude Code en la terminal (vuelve a este ordenador).
  // Cualquier otro destino se rechaza, venga por donde venga
  const admitido = (d) => !!d && (d.local || d.claude);
  const volver = (url) => {
    if (!admitido(destino(url))) return fallo("Esta conexión no se puede completar de forma segura.");
    olvidar();
    location.assign(url);
  };

  // en esta pestaña se está escribiendo un código: la sesión que llegue es la suya, no la de otra pestaña
  let entrandoAqui = false;

  async function arrancar() {
    const enlace = delEnlace();
    if (!CFG.supabaseUrl || !CFG.publishableKey || !CFG.entrar) return fallo("Esta página no está configurada.");
    // la sesión del enlace se lee aquí, a mano (delEnlace): la librería no mira la dirección
    const crear = (auth) => window.supabase.createClient(CFG.supabaseUrl, CFG.publishableKey, { auth: { flowType: "implicit", detectSessionInUrl: false, ...auth } });
    const sb = crear({ persistSession: true });
    const poner = async (cliente, tokens) => { try { return await cliente.auth.setSession(tokens); } catch { return { error: true }; } };

    const q = new URLSearchParams(location.search).get("authorization_id");
    if (q && ID_VALIDO.test(q)) guardar(q);
    const id = q && ID_VALIDO.test(q) ? q : pendiente();

    let aviso = null;
    if (enlace?.acceso) {
      // La sesión del enlace se comprueba con Auth en un cliente que no guarda nada: una inventada no entra, y de una de verdad se sabe de quién es
      const suelto = crear({ persistSession: false, autoRefreshToken: false, storageKey: "editormax-enlace" });
      const tokens = { access_token: enlace.acceso, refresh_token: enlace.refresco };
      const r = await poner(suelto, tokens);
      const correo = r.error ? "" : (r.data?.user?.email ?? "").toLowerCase();
      if (!correo) aviso = GASTADO;
      else if (correo === pedido()) {
        // este navegador pidió ese correo: la sesión es suya y se queda
        if ((await poner(sb, tokens)).error) aviso = GASTADO; else olvidarPedido();
      } else if (id) {
        // Nadie pidió ese correo desde aquí (el enlace se abrió en otro navegador, o no lo ha mandado EditorMax). No se guarda ni sustituye a la sesión
        // que hubiera: vale para esta pestaña, y solo cuando la persona ve la cuenta y la confirma
        return autorizar(suelto, id, correo, { confirmar: true, base: sb });
      } else aviso = "Abre el enlace del correo en el navegador donde lo pediste, o pide otro.";
    } else if (enlace?.gastado) aviso = GASTADO;

    // otra pestaña de este navegador ha entrado con el enlace mientras esta esperaba: se sigue allí
    sb.auth.onAuthStateChange((evento, sesion) => { if (evento === "SIGNED_IN" && sesion && !entrandoAqui && !$("enviado").hidden) ver("otra"); });

    const { data: { session } } = await sb.auth.getSession();
    if (!session) return pedirCorreo(sb, id, aviso);
    if (!id) return ver("listo");
    await autorizar(sb, id, session.user?.email ?? "");
  }

  function pedirCorreo(sb, id, aviso = null) {
    const avisar = (m) => { $("correo-aviso").textContent = m ?? ""; $("correo-aviso").hidden = !m; };
    avisar(aviso);
    $("enviar").disabled = false;
    ver("correo");
    $("form-correo").onsubmit = async (e) => {
      e.preventDefault();
      const email = $("email").value.trim();
      if (!email) return;
      $("enviar").disabled = true;
      try {
        await fetch(CFG.entrar, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(id ? { email, autorizacion: id } : { email }) });
      } catch {
        $("enviar").disabled = false;
        return avisar("No se pudo enviar. Revisa tu conexión y vuelve a intentarlo.");
      }
      apuntarPedido(email);
      esperar(sb, email, id);
    };
  }

  // «Revisa tu correo». Con el enlace se sigue en la pestaña que abre; con un código, aquí. CFG.correo dice qué trae el correo: "enlace" (solo el
  // enlace: no se ofrece escribir un código que el correo no trae), "codigo" (solo el código: se pide desde el principio) o "ambos" (el enlace, y
  // «Introducir un código» para quien prefiera escribirlo).
  function esperar(sb, email, idDeLaUrl) {
    const conCodigo = CFG.correo === "codigo";
    const ofreceCodigo = CFG.correo === "ambos";
    const mal = (m) => { $("codigo-error").textContent = m; $("codigo-error").hidden = false; };
    const abrirCodigo = () => { $("form-codigo").hidden = false; $("con-codigo").hidden = true; $("codigo").focus(); };
    for (const n of document.querySelectorAll(".enviado-a")) n.textContent = email;
    $("enviado-enlace").hidden = conCodigo;
    $("enviado-codigo").hidden = !conCodigo;
    $("form-codigo").hidden = !conCodigo;
    $("con-codigo").hidden = !ofreceCodigo;
    $("con-codigo").onclick = abrirCodigo;
    $("codigo").value = "";
    $("codigo-error").hidden = true;
    $("entrar-codigo").disabled = false;
    entrandoAqui = false;
    $("form-codigo").onsubmit = async (e) => {
      e.preventDefault();
      const token = $("codigo").value.replace(/\s+/g, "");
      if (!/^[0-9]{6,10}$/.test(token)) return mal("Escribe el código tal como aparece en el correo.");
      $("entrar-codigo").disabled = true;
      entrandoAqui = true;
      const otraVez = (m) => { entrandoAqui = false; $("entrar-codigo").disabled = false; mal(m); };
      let r;
      try { r = await sb.auth.verifyOtp({ email, token, type: "email" }); } catch { return otraVez("No se pudo comprobar. Revisa tu conexión y vuelve a intentarlo."); }
      if (r.error || !r.data?.session) return otraVez("Ese código no es correcto o ha caducado.");
      const id = idDeLaUrl ?? pendiente();
      if (id) await autorizar(sb, id, r.data.user?.email ?? email);
      else ver("listo");
    };
    ver("enviado");
  }

  // `sb` es el cliente con la sesión que autoriza. Con `confirmar`, esa sesión llegó en un enlace que este navegador no pidió: nada se sigue sin que la
  // persona vea la cuenta y pulse. `base` es el cliente del navegador, para pedir el correo de otra cuenta.
  async function autorizar(sb, id, email, { confirmar = false, base = sb } = {}) {
    const { data, error } = await sb.auth.oauth.getAuthorizationDetails(id);
    // la sesión se queda en este navegador: al conectar otra vez desde Claude no hace falta otro correo
    if (error || !data) { olvidar(); return fallo("Esta conexión ha caducado. Vuelve a Claude y conecta EditorMax otra vez."); }
    const yaAutorizada = !("authorization_id" in data);
    if (yaAutorizada && !confirmar) return volver(data.redirect_url);
    const d = destino(yaAutorizada ? data.redirect_url : data.redirect_uri);
    if (!admitido(d)) return fallo("Esta conexión no se puede completar de forma segura.");
    // Claude Code, en la terminal, espera la respuesta en el ordenador: desde un teléfono no le llega. A la app de Claude sí, desde donde sea
    if (d.local && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return fallo("Abre el enlace del correo en el ordenador donde usas Claude.");
    $("app-nombre").textContent = (data.client?.name ?? "Claude").replace(/\s+/g, " ").trim().slice(0, 60) || "Claude";
    // Quién puede haber pedido esto. Una conexión desde la app vuelve a Claude, en internet: quien la empezó en SU Claude puede mandarle el enlace a otra
    // persona, y si esa persona autoriza, le da su EditorMax. La página no puede saber quién la empezó (llega igual), así que lo dice claro antes del botón.
    // Una desde la terminal vuelve a este ordenador: solo puede haberla empezado alguien en él.
    $("solo-si").textContent = d.claude
      ? "Vas a dar acceso a tu EditorMax a una cuenta de Claude. Autoriza solo si eres tú quien acaba de pulsar «Conectar» en tu Claude. Si este enlace te ha llegado por correo o en un mensaje, pulsa Cancelar."
      : "Autoriza solo si acabas de conectar EditorMax tú, en este ordenador.";
    $("cuenta").textContent = email;
    $("autorizar-si").disabled = $("autorizar-no").disabled = false;
    ver("autorizar");
    const decide = async (metodo) => {
      $("autorizar-si").disabled = $("autorizar-no").disabled = true;
      const r = await sb.auth.oauth[metodo](id, { skipBrowserRedirect: true });
      if (r.error || !r.data?.redirect_url) { $("autorizar-si").disabled = $("autorizar-no").disabled = false; return fallo("No se pudo completar. Vuelve a intentarlo."); }
      volver(r.data.redirect_url);
    };
    // ya autorizada antes con esta cuenta: Auth no pregunta otra vez, así que la confirmación es este clic
    $("autorizar-si").onclick = yaAutorizada ? () => volver(data.redirect_url) : () => decide("approveAuthorization");
    $("autorizar-no").onclick = yaAutorizada ? () => { olvidar(); fallo("No se ha conectado nada. Ya puedes cerrar esta pestaña."); } : () => decide("denyAuthorization");
    $("cambiar").onclick = async () => { await sb.auth.signOut({ scope: "local" }); pedirCorreo(base, id); };
  }

  arrancar().catch(() => fallo("Algo ha fallado. Vuelve a intentarlo."));
})();
