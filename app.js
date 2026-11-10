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

  // Lo que trae el enlace del correo, detrás de «#»: la sesión, o el aviso de que ya no vale. Se lee y se quita de la barra y del historial antes de nada.
  function delEnlace() {
    const f = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    const acceso = f.get("access_token"), refresco = f.get("refresh_token");
    if (acceso && refresco) return { acceso, refresco };
    return f.get("error") || f.get("error_code") ? { gastado: true } : null;
  }

  const esLocal = (h) => h === "localhost" || h === "::1" || h === "[::1]" || /^127(\.\d{1,3}){3}$/.test(h);
  // solo se vuelve a una web por HTTPS o a este ordenador
  function destino(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol === "https:") return { host: u.host, local: esLocal(u.hostname) };
    if (u.protocol === "http:" && esLocal(u.hostname)) return { host: u.host, local: true };
    return null;
  }
  const volver = (url) => {
    // EditorMax solo se conecta desde Claude Code, que vuelve a este ordenador: cualquier otro destino se rechaza, venga por donde venga
    if (!destino(url)?.local) return fallo("Esta conexión no se puede completar de forma segura.");
    olvidar();
    location.assign(url);
  };

  // en esta pestaña se está escribiendo un código: la sesión que llegue es la suya, no la de otra pestaña
  let entrandoAqui = false;

  async function arrancar() {
    const enlace = delEnlace();
    if (!CFG.supabaseUrl || !CFG.publishableKey || !CFG.entrar) return fallo("Esta página no está configurada.");
    // la sesión del enlace se lee aquí, a mano (delEnlace): la librería no mira la dirección
    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.publishableKey, { auth: { flowType: "implicit", detectSessionInUrl: false, persistSession: true } });

    const q = new URLSearchParams(location.search).get("authorization_id");
    if (q && ID_VALIDO.test(q)) guardar(q);
    const id = q && ID_VALIDO.test(q) ? q : pendiente();

    let aviso = null;
    if (enlace?.acceso) {
      // Supabase comprueba la sesión antes de guardarla: una inventada no entra
      let r;
      try { r = await sb.auth.setSession({ access_token: enlace.acceso, refresh_token: enlace.refresco }); } catch { r = { error: true }; }
      if (r.error) aviso = GASTADO;
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
      esperar(sb, email, id);
    };
  }

  // «Revisa tu correo». Con el enlace se sigue en la pestaña que abre; con un código, aquí. CFG.correo dice qué trae el correo ("enlace" o "codigo").
  function esperar(sb, email, idDeLaUrl) {
    const conCodigo = CFG.correo === "codigo";
    const mal = (m) => { $("codigo-error").textContent = m; $("codigo-error").hidden = false; };
    const abrirCodigo = () => { $("form-codigo").hidden = false; $("con-codigo").hidden = true; $("codigo").focus(); };
    for (const n of document.querySelectorAll(".enviado-a")) n.textContent = email;
    $("enviado-enlace").hidden = conCodigo;
    $("enviado-codigo").hidden = !conCodigo;
    $("form-codigo").hidden = !conCodigo;
    $("con-codigo").hidden = conCodigo;
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

  async function autorizar(sb, id, email) {
    const { data, error } = await sb.auth.oauth.getAuthorizationDetails(id);
    // la sesión se queda en este navegador: al conectar otra vez desde Claude Code no hace falta otro correo
    if (error || !data) { olvidar(); return fallo("Esta conexión ha caducado. Vuelve a Claude Code y conecta EditorMax otra vez."); }
    if (!("authorization_id" in data)) return volver(data.redirect_url);
    const d = destino(data.redirect_uri);
    if (!d?.local) return fallo("Esta conexión no se puede completar de forma segura.");
    // Claude Code espera la respuesta en el ordenador: desde un teléfono no le llega
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return fallo("Abre el enlace del correo en el ordenador donde usas Claude Code.");
    $("app-nombre").textContent = (data.client?.name ?? "Claude Code").replace(/\s+/g, " ").trim().slice(0, 60) || "Claude Code";
    $("cuenta").textContent = email;
    ver("autorizar");
    const decide = async (metodo) => {
      $("autorizar-si").disabled = $("autorizar-no").disabled = true;
      const r = await sb.auth.oauth[metodo](id, { skipBrowserRedirect: true });
      if (r.error || !r.data?.redirect_url) { $("autorizar-si").disabled = $("autorizar-no").disabled = false; return fallo("No se pudo completar. Vuelve a intentarlo."); }
      volver(r.data.redirect_url);
    };
    $("autorizar-si").onclick = () => decide("approveAuthorization");
    $("autorizar-no").onclick = () => decide("denyAuthorization");
    $("cambiar").onclick = async () => { await sb.auth.signOut({ scope: "local" }); pedirCorreo(sb, id); };
  }

  arrancar().catch(() => fallo("Algo ha fallado. Vuelve a intentarlo."));
})();
