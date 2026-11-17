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
  const PANTALLAS = ["cargando", "correo", "enviado", "confirmar", "autorizar", "listo", "otra", "error"];
  const ver = (p) => PANTALLAS.forEach((x) => { $(x).hidden = x !== p; });
  const fallo = (m) => { $("error-texto").textContent = m; ver("error"); };
  const GASTADO = "Ese enlace ya se ha usado o ha caducado. Pide otro.";

  // EL CÓDIGO (17/11). Seis cifras: las que pone Auth (Authentication › Sign In / Providers › Email › Email OTP Length) y las casillas de la página.
  const CIFRAS = 6;
  // lo que vive un código: lo que dice el correo y lo que tiene Auth (Email OTP Expiration, 3600 s)
  const TTL_CODIGO = 60 * 60_000;
  // cuánto hay que esperar para pedir otro: el primero, medio minuto; los siguientes, uno (el servidor manda como mucho 4 por hora a un correo)
  const ESPERA_OTRO = [30, 60];
  // El código que hay en un texto pegado. Tal cual; o copiado con lo de alrededor («Tu código… 123456»); o partido («123 456», «123-456»)
  function codigoDe(pegado) {
    const t = String(pegado ?? "");
    const justo = (x) => new RegExp(`(?:^|[^0-9])([0-9]{${CIFRAS}})(?![0-9])`).exec(x)?.[1] ?? null;
    return justo(t) ?? justo(t.replace(/([0-9])[  \t.–—-](?=[0-9])/g, "$1")) ?? t.replace(/[^0-9]+/g, "").slice(0, CIFRAS);
  }
  // Un botón mientras hace lo suyo: dice qué está haciendo y gira (estilo.css, .ocupado). No se puede volver a pulsar
  const ocupar = (b, haciendo) => { b.dataset.texto ??= b.textContent; b.textContent = haciendo; b.classList.add("ocupado"); b.disabled = true; b.setAttribute("aria-busy", "true"); };
  const soltar = (b) => { if (b.dataset.texto) b.textContent = b.dataset.texto; b.classList.remove("ocupado"); b.disabled = false; b.removeAttribute("aria-busy"); };
  // lo que dura algo que se ve. Con «menos movimiento» en el sistema no hay animación ni espera
  const quieto = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
  const ver_un_momento = (ms) => new Promise((r) => setTimeout(r, quieto() ? 0 : ms));
  // Pide el correo de entrada al servidor. Contesta siempre lo mismo tenga acceso o no; aquí solo se sabe si llegó la petición
  async function pedir(email, id) {
    let r;
    try { r = await fetch(CFG.entrar, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(id ? { email, autorizacion: id } : { email }) }); } catch { return "red"; }
    return r.ok ? "enviado" : r.status === 429 ? "tope" : "fallo";
  }
  const NO_ENVIADO = { red: "No se pudo enviar. Revisa tu conexión y vuelve a intentarlo.", tope: "Demasiados intentos seguidos. Espera un minuto y vuelve a intentarlo.", fallo: "No se pudo enviar. Vuelve a intentarlo en un momento." };

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
    // el enlace de nuestro correo: la huella del código, con su forma
    const huella = f.get("entrar");
    if (huella && /^[A-Za-z0-9_-]{32,128}$/.test(huella)) return { huella };
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

    // un cliente que no guarda nada: en él se comprueba con Auth lo que llega en un enlace, antes de decidir si se queda en este navegador
    const suelto = () => crear({ persistSession: false, autoRefreshToken: false, storageKey: "editormax-enlace" });

    // lo que sigue cuando ya se sabe qué trajo el enlace (o si no había ninguno)
    const seguir = async (aviso = null) => {
      // otra pestaña de este navegador ha entrado con el enlace mientras esta esperaba: se sigue allí
      sb.auth.onAuthStateChange((evento, sesion) => { if (evento === "SIGNED_IN" && sesion && !entrandoAqui && !$("enviado").hidden) ver("otra"); });
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return pedirCorreo(sb, id, aviso);
      if (!id) return ver("listo");
      await autorizar(sb, id, session.user?.email ?? "");
    };

    // Una sesión que llegó por un enlace, ya comprobada con Auth en `cliente`. `correo`, de quién es («» si Auth no la dio por buena)
    const conSesionDelEnlace = async (cliente, tokens, correo) => {
      if (!correo) return seguir(GASTADO);
      if (correo === pedido()) {
        // este navegador pidió ese correo: la sesión es suya y se queda
        if ((await poner(sb, tokens)).error) return seguir(GASTADO);
        olvidarPedido();
        return seguir();
      }
      // Nadie pidió ese correo desde aquí (el enlace se abrió en otro navegador, o no lo ha mandado EditorMax). No se guarda ni sustituye a la sesión
      // que hubiera: vale para esta pestaña, y solo cuando la persona ve la cuenta y la confirma
      if (id) return autorizar(cliente, id, correo, { confirmar: true, base: sb });
      return seguir("Abre el enlace del correo en el navegador donde lo pediste, o pide otro.");
    };

    if (enlace?.huella) {
      // EL ENLACE DE NUESTRO CORREO (17/11). No trae una sesión: trae la huella del código, que es la misma credencial de un solo uso. ABRIRLO NO LA
      // GASTA: un escáner de correo que siga el enlace (Defender Safe Links) llega hasta aquí y no pasa. Solo se canjea cuando la persona pulsa.
      const avisar = (m) => { $("confirmar-aviso").textContent = m ?? ""; $("confirmar-aviso").hidden = !m; };
      avisar(null);
      $("confirmar-si").disabled = false;
      soltar($("confirmar-si"));
      $("confirmar-si").onclick = async () => {
        ocupar($("confirmar-si"), "Entrando…");
        avisar(null);
        const cliente = suelto();
        let r;
        try { r = await cliente.auth.verifyOtp({ token_hash: enlace.huella, type: "email" }); } catch { r = { error: { name: "AuthRetryableFetchError" } }; }
        // sin red no se ha gastado nada: se puede volver a pulsar
        if (r.error && (r.error.name === "AuthRetryableFetchError" || r.error.status === 0 || r.error.status >= 500)) {
          soltar($("confirmar-si"));
          return avisar("No se pudo comprobar. Revisa tu conexión y vuelve a intentarlo.");
        }
        const s = r.error ? null : r.data?.session;
        if (!s) return seguir(GASTADO);
        return conSesionDelEnlace(cliente, { access_token: s.access_token, refresh_token: s.refresh_token }, (r.data.user?.email ?? "").toLowerCase());
      };
      return ver("confirmar");
    }
    if (enlace?.acceso) {
      // El enlace del correo de Auth: llega con la sesión ya hecha. Se comprueba con Auth: una inventada no entra, y de una de verdad se sabe de quién es
      const cliente = suelto();
      const tokens = { access_token: enlace.acceso, refresh_token: enlace.refresco };
      const r = await poner(cliente, tokens);
      return conSesionDelEnlace(cliente, tokens, r.error ? "" : (r.data?.user?.email ?? "").toLowerCase());
    }
    await seguir(enlace?.gastado ? GASTADO : null);
  }

  function pedirCorreo(sb, id, aviso = null) {
    const avisar = (m) => { $("correo-aviso").textContent = m ?? ""; $("correo-aviso").hidden = !m; };
    avisar(aviso);
    soltar($("enviar"));
    ver("correo");
    $("form-correo").onsubmit = async (e) => {
      e.preventDefault();
      const email = $("email").value.trim();
      if (!email) return;
      avisar(null);
      ocupar($("enviar"), "Enviando…");
      const r = await pedir(email, id);
      // el servidor puede no haber mandado nada (demasiados intentos seguidos desde esta red, o un fallo suyo): hasta el 15/11 la página decía
      // «revisa tu correo» igual, y se esperaba un correo que no iba a llegar. El tope se cuenta antes de mirar el correo: no dice nada de nadie
      if (r !== "enviado") {
        soltar($("enviar"));
        return avisar(NO_ENVIADO[r]);
      }
      apuntarPedido(email);
      esperar(sb, email, id);
    };
  }

  // «Revisa tu correo». Con el enlace se sigue en la pestaña que abre; con un código, aquí. CFG.correo dice qué trae el correo: "enlace" (solo el
  // enlace de Auth: no se ofrece escribir un código que el correo no trae), "codigo" (solo el código) o "ambos" (nuestro correo, desde el 17/11: el
  // código y un botón). Con código, se pide desde el principio: es lo primero del correo, y esta página es la que la persona tiene abierta.
  function esperar(sb, email, idDeLaUrl) {
    const ambos = CFG.correo === "ambos";
    const conCodigo = CFG.correo === "codigo" || ambos;
    const form = $("form-codigo"), campo = $("codigo"), casillas = [...document.querySelectorAll("#casillas .casilla")];
    for (const n of document.querySelectorAll(".enviado-a")) n.textContent = email;
    $("enviado-enlace").hidden = conCodigo;
    $("enviado-codigo").hidden = !conCodigo || ambos;
    $("enviado-ambos").hidden = !ambos;
    form.hidden = !conCodigo;
    entrandoAqui = false;

    // LAS CASILLAS SON UN SOLO CAMPO DE VERDAD, con las seis pintadas debajo: así pegar, el teclado de números del móvil y el código que ofrece el
    // sistema («autocomplete="one-time-code"») funcionan como en cualquier campo, y un lector de pantalla oye un campo y no seis
    const pinta = () => {
      const v = campo.value, aqui = document.activeElement === campo && !campo.readOnly;
      casillas.forEach((c, i) => { c.textContent = v[i] ?? ""; c.classList.toggle("llena", i < v.length); c.classList.toggle("activa", aqui && i === Math.min(v.length, CIFRAS - 1)); });
    };
    const alFinal = () => { try { campo.setSelectionRange(campo.value.length, campo.value.length); } catch { /* nada */ } };
    const mal = (m, { vaciar = false } = {}) => {
      $("codigo-error").textContent = m;
      $("codigo-error").hidden = false;
      campo.setAttribute("aria-invalid", "true");
      // (la clase se quita y se vuelve a poner para que el temblor empiece otra vez)
      form.classList.remove("mal"); void form.offsetWidth; form.classList.add("mal");
      if (vaciar) campo.value = "";
      pinta();
    };
    const bien = () => { $("codigo-error").hidden = true; campo.removeAttribute("aria-invalid"); form.classList.remove("mal"); };
    const estado = (m) => { $("codigo-estado").textContent = m ?? ""; };

    // pedir otro código: hay que esperar un poco (lo cuenta), y con uno caducado es lo que se ofrece
    let enviadoEn = Date.now(), pedidos = 0, hasta = 0, reloj = null;
    const tic = () => {
      const s = Math.ceil((hasta - Date.now()) / 1000);
      $("otro-espera").hidden = s <= 0;
      $("otro-codigo").hidden = s > 0;
      if (s > 0) $("otro-segundos").textContent = String(s);
      else { clearInterval(reloj); reloj = null; }
    };
    const aEsperar = () => { hasta = Date.now() + ESPERA_OTRO[Math.min(pedidos, ESPERA_OTRO.length - 1)] * 1000; pedidos += 1; clearInterval(reloj); reloj = setInterval(tic, 250); tic(); };
    const dejar = () => { clearInterval(reloj); reloj = null; };
    // quien va a mirar el correo deja esta pestaña detrás, y ahí el navegador frena los relojes: al volver, la cuenta se pone al día en el acto
    document.onvisibilitychange = () => { if (reloj) tic(); };
    // con el código caducado no hay nada que escribir: lo que toca es pedir otro, y es el único botón
    const destacarOtro = (si) => { $("otro-codigo").classList.toggle("enlace", !si); $("otro-codigo").classList.toggle("secundario", si); $("entrar-codigo").hidden = si; };

    let ocupado = false;
    const libre = () => { ocupado = false; entrandoAqui = false; campo.readOnly = false; form.classList.remove("comprobando"); $("entrar-codigo").classList.remove("hecho"); soltar($("entrar-codigo")); };
    const entrar = async () => {
      if (ocupado) return;
      const token = campo.value;
      if (token.length !== CIFRAS) { mal(`Escribe las ${CIFRAS} cifras del código.`); return campo.focus(); }
      ocupado = true;
      entrandoAqui = true;
      bien();
      estado(null);
      campo.readOnly = true;
      form.classList.add("comprobando");
      ocupar($("entrar-codigo"), "Entrando…");
      pinta();
      let r;
      try { r = await sb.auth.verifyOtp({ email, token, type: "email" }); } catch { r = { error: { name: "AuthRetryableFetchError" } }; }
      if (r.error || !r.data?.session) {
        const e = r.error ?? {};
        libre();
        // sin red no se ha comprobado nada: el código se queda escrito
        if (e.name === "AuthRetryableFetchError" || e.status === 0 || e.status >= 500) mal("No se pudo comprobar. Revisa tu conexión y vuelve a intentarlo.");
        else if (e.status === 429) mal("Demasiados intentos seguidos. Espera un minuto y vuelve a intentarlo.");
        // Auth contesta lo mismo a un código que no es y a uno caducado. Lo que sí se sabe aquí es cuándo se pidió
        else if (Date.now() - enviadoEn >= TTL_CODIGO) { mal("Ese código ha caducado. Pide uno nuevo: te llega en un momento.", { vaciar: true }); hasta = 0; tic(); destacarOtro(true); return $("otro-codigo").focus(); }
        else mal("Ese código no es correcto. Revísalo, o usa el del último correo que te hemos enviado.", { vaciar: true });
        return campo.focus();
      }
      // dentro: se ve un momento, y se sigue
      dejar();
      form.classList.remove("comprobando");
      form.classList.add("dentro");
      $("entrar-codigo").classList.remove("ocupado");
      $("entrar-codigo").classList.add("hecho");
      $("entrar-codigo").textContent = "Dentro";
      await ver_un_momento(700);
      const id = idDeLaUrl ?? pendiente();
      if (id) await autorizar(sb, id, r.data.user?.email ?? email);
      else ver("listo");
    };

    campo.value = "";
    libre();
    bien();
    estado(null);
    form.classList.remove("dentro");
    destacarOtro(false);
    // lo que no es una cifra no entra, y con la última se entra solo
    campo.oninput = () => {
      const v = campo.value.replace(/[^0-9]+/g, "").slice(0, CIFRAS);
      if (v !== campo.value) campo.value = v;
      bien();
      pinta();
      if (v.length === CIFRAS) entrar();
    };
    // pegado: el código entero de una vez, venga como venga
    campo.onpaste = (e) => {
      e.preventDefault();
      if (campo.readOnly) return;
      campo.value = codigoDe(e.clipboardData?.getData("text"));
      bien();
      pinta();
      if (campo.value.length === CIFRAS) entrar();
    };
    campo.onfocus = campo.onblur = pinta;
    // el cursor va siempre al final: las casillas se llenan en orden
    campo.onclick = campo.onkeyup = campo.onselect = alFinal;
    form.onsubmit = (e) => { e.preventDefault(); return entrar(); };
    $("otro-codigo").onclick = async () => {
      if (ocupado) return;
      ocupar($("otro-codigo"), "Enviando…");
      const r = await pedir(email, idDeLaUrl);
      soltar($("otro-codigo"));
      if (r !== "enviado") return mal(NO_ENVIADO[r]);
      apuntarPedido(email);
      enviadoEn = Date.now();
      campo.value = "";
      bien();
      destacarOtro(false);
      aEsperar();
      estado("Te hemos enviado un código nuevo. El anterior ya no vale.");
      campo.focus();
      pinta();
    };
    $("otro-correo").onclick = () => { if (ocupado) return; dejar(); pedirCorreo(sb, idDeLaUrl); $("email").focus(); $("email").select(); };
    aEsperar();
    ver("enviado");
    pinta();
    if (conCodigo) { campo.focus(); pinta(); }
  }

  // `sb` es el cliente con la sesión que autoriza. Con `confirmar`, esa sesión llegó en un enlace que este navegador no pidió: nada se sigue sin que la
  // persona vea la cuenta y pulse. `base` es el cliente del navegador, para pedir el correo de otra cuenta.
  async function autorizar(sb, id, email, { confirmar = false, base = sb } = {}) {
    const { data, error } = await sb.auth.oauth.getAuthorizationDetails(id);
    // la sesión se queda en este navegador: al conectar otra vez desde Claude no hace falta otro correo
    if (error || !data) { olvidar(); return fallo("Esta conexión ha caducado. Vuelve a Claude y conecta EditorMax otra vez."); }
    const yaAutorizada = !("authorization_id" in data);
    // ya autorizada antes: solo se vuelve sin preguntar si la vuelta es a este ordenador (la terminal). Si es a Claude, en internet, siempre se enseña
    // la cuenta y el recordatorio y hace falta el clic: sin él, abrir un enlace de autorización (o que una página lleve a él) devolvía la conexión
    // sin que la persona viera nada (revisión del 15/11)
    if (yaAutorizada && !confirmar && destino(data.redirect_url)?.local) return volver(data.redirect_url);
    const d = destino(yaAutorizada ? data.redirect_url : data.redirect_uri);
    if (!admitido(d)) return fallo("Esta conexión no se puede completar de forma segura.");
    // Claude Code, en la terminal, espera la respuesta en el ordenador: desde un teléfono no le llega. A la app de Claude sí, desde donde sea
    if (d.local && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return fallo("Abre el enlace del correo en el ordenador donde usas Claude.");
    $("app-nombre").textContent = (data.client?.name ?? "Claude").replace(/\s+/g, " ").trim().slice(0, 60) || "Claude";
    // Quién puede haber pedido esto. Una conexión desde la app vuelve a Claude, en internet: quien la empezó en SU Claude puede mandarle el enlace a otra
    // persona, y si esa persona autoriza, le da su EditorMax. La página no puede saber quién la empezó (llega igual). Ese riesgo está aceptado tal cual
    // (Enrique, 14/11: «make it a small, calm reminder, not an alarm. I accept that risk as it is»): antes del botón va un recordatorio corto, no un aviso.
    // Una desde la terminal vuelve a este ordenador: solo puede haberla empezado alguien en él.
    $("solo-si").textContent = d.claude
      ? "Autoriza solo si acabas de conectar EditorMax en tu Claude."
      : "Autoriza solo si acabas de conectar EditorMax tú, en este ordenador.";
    $("cuenta").textContent = email;
    $("autorizar-si").disabled = $("autorizar-no").disabled = false;
    ver("autorizar");
    const decide = async (metodo) => {
      $("autorizar-si").disabled = $("autorizar-no").disabled = true;
      const r = await sb.auth.oauth[metodo](id, { skipBrowserRedirect: true });
      if (r.error || !r.data?.redirect_url) {
        // si la conexión caducó mientras la pantalla estaba abierta (dura 10 minutos), reintentar no sirve: se dice lo que hay que hacer
        const sigue = await sb.auth.oauth.getAuthorizationDetails(id).catch(() => null);
        if (!sigue || sigue.error || !sigue.data) { olvidar(); return fallo("Esta conexión ha caducado. Vuelve a Claude y conecta EditorMax otra vez."); }
        $("autorizar-si").disabled = $("autorizar-no").disabled = false;
        return fallo("No se pudo completar. Vuelve a intentarlo.");
      }
      volver(r.data.redirect_url);
    };
    // ya autorizada antes con esta cuenta: Auth no pregunta otra vez, así que la confirmación es este clic
    $("autorizar-si").onclick = yaAutorizada ? () => volver(data.redirect_url) : () => decide("approveAuthorization");
    $("autorizar-no").onclick = yaAutorizada ? () => { olvidar(); fallo("No se ha conectado nada. Ya puedes cerrar esta pestaña."); } : () => decide("denyAuthorization");
    $("cambiar").onclick = async () => { await sb.auth.signOut({ scope: "local" }); pedirCorreo(base, id); };
  }

  arrancar().catch(() => fallo("Algo ha fallado. Vuelve a intentarlo."));
})();
