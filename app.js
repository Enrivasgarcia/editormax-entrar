// La página de entrada y autorización de EditorMax. Supabase manda aquí con ?authorization_id=…; si no hay sesión se pide el correo, y al
// escribir el código que llega se retoma la autorización. El destino se comprueba siempre: el nombre lo declara el cliente, el host no se puede fingir.
(() => {
  const CFG = window.EM_CONFIG ?? {};
  const CLAVE = "editormax:autorizacion";
  const TTL = 15 * 60_000;
  const ID_VALIDO = /^[A-Za-z0-9_-]{8,256}$/;
  const $ = (id) => document.getElementById(id);
  const PANTALLAS = ["cargando", "correo", "enviado", "autorizar", "listo", "error"];
  const ver = (p) => PANTALLAS.forEach((x) => { $(x).hidden = x !== p; });
  const fallo = (m) => { $("error-texto").textContent = m; ver("error"); };

  const guardar = (id) => { try { localStorage.setItem(CLAVE, JSON.stringify({ id, t: Date.now() })); } catch { /* sin almacenamiento: seguirá en la misma pestaña */ } };
  const olvidar = () => { try { localStorage.removeItem(CLAVE); } catch { /* nada */ } };
  const pendiente = () => {
    try {
      const { id, t } = JSON.parse(localStorage.getItem(CLAVE) ?? "{}");
      return typeof t === "number" && Date.now() - t < TTL && ID_VALIDO.test(id ?? "") ? id : null;
    } catch { return null; }
  };

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

  async function arrancar() {
    if (!CFG.supabaseUrl || !CFG.publishableKey || !CFG.entrar) return fallo("Esta página no está configurada.");
    // el correo solo lleva un código: ninguna sesión legítima llega en la URL
    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.publishableKey, { auth: { flowType: "implicit", detectSessionInUrl: false, persistSession: true } });

    const q = new URLSearchParams(location.search).get("authorization_id");
    if (q && ID_VALIDO.test(q)) guardar(q);
    const id = q && ID_VALIDO.test(q) ? q : pendiente();

    const { data: { session } } = await sb.auth.getSession();
    if (!session) return pedirCorreo(sb, id);
    if (!id) return ver("listo");
    await autorizar(sb, id, session.user?.email ?? "");
  }

  function pedirCorreo(sb, id) {
    ver("correo");
    $("enviar").disabled = false;
    $("form-correo").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("email").value.trim();
      if (!email) return;
      $("enviar").disabled = true;
      try {
        await fetch(CFG.entrar, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
        $("enviado-a").textContent = email;
        esperarCodigo(sb, email, id);
        ver("enviado");
      } catch {
        $("enviar").disabled = false;
        fallo("No se pudo enviar. Revisa tu conexión y vuelve a intentarlo.");
      }
    }, { once: true });
  }

  // el código del correo. La autorización llega por la URL; lo guardado es solo el respaldo, y sin almacenamiento no existe
  function esperarCodigo(sb, email, idDeLaUrl) {
    const mal = (m) => { $("codigo-error").textContent = m; $("codigo-error").hidden = false; };
    $("codigo").value = "";
    $("codigo-error").hidden = true;
    $("entrar-codigo").disabled = false;
    $("form-codigo").onsubmit = async (e) => {
      e.preventDefault();
      const token = $("codigo").value.replace(/\s+/g, "");
      if (!/^[0-9]{6,10}$/.test(token)) return mal("Escribe el código tal como aparece en el correo.");
      $("entrar-codigo").disabled = true;
      let r;
      try { r = await sb.auth.verifyOtp({ email, token, type: "email" }); } catch { $("entrar-codigo").disabled = false; return mal("No se pudo comprobar. Revisa tu conexión y vuelve a intentarlo."); }
      if (r.error || !r.data?.session) { $("entrar-codigo").disabled = false; return mal("Ese código no es correcto o ha caducado."); }
      const id = idDeLaUrl ?? pendiente();
      if (id) await autorizar(sb, id, r.data.user?.email ?? email);
      else ver("listo");
    };
  }

  async function autorizar(sb, id, email) {
    const { data, error } = await sb.auth.oauth.getAuthorizationDetails(id);
    if (error || !data) { olvidar(); return fallo("Este enlace ha caducado. Vuelve a Claude Code y empieza de nuevo."); }
    if (!("authorization_id" in data)) return volver(data.redirect_url);
    const d = destino(data.redirect_uri);
    if (!d?.local) return fallo("Esta conexión no se puede completar de forma segura.");
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
