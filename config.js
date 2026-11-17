// Datos públicos de la página. La clave publicable es pública por diseño; ninguna secreta va aquí nunca.
window.EM_CONFIG = {
  supabaseUrl: "https://oxgcvxnvzjustschqoeq.supabase.co",
  publishableKey: "sb_publishable_ZJRM5RxUOC2swo74zNl4cg_m_vBMno8",
  entrar: "https://oxgcvxnvzjustschqoeq.supabase.co/functions/v1/editormax-mcp/entrar",
  // qué trae el correo de entrada: "ambos" (nuestro correo, desde el 17/11: el código de 6 cifras y un botón; funciones/editormax-mcp/correo.ts),
  // "codigo" (solo el código) o "enlace" (el de Supabase tal cual, que ya no se manda: no se ofrece escribir un código)
  correo: "ambos",
};
