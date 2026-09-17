/* =========================================================================
   CONFIGURACIÓN DE SUPABASE
   =========================================================================
   Pega aquí los datos de TU proyecto de Supabase para que la app sincronice
   productos, categorías, ventas e inventario entre todos los celulares.

   Cómo conseguirlos:
   1. Entra a https://supabase.com y crea un proyecto (plan gratis).
   2. Dentro del proyecto, ve al menú lateral izquierdo →
      "Project Settings" → "API".
   3. Copia estos dos valores:
        Project URL        -> es el "supabaseUrl" (termina en .supabase.co)
        anon public key    -> es el "supabaseAnonKey"
   4. Abre "SQL Editor", pega TODO el contenido de supabase_setup.sql y
      presiona Run (crea las tablas y activa el tiempo real).

   Antes de esta migración la app usaba Firebase. El estado de sincronización
   antiguo ("stockferre_firebase_v1") se reutiliza tal cual: si estaba
   encendido en este dispositivo, sigue encendido.

   Si dejas esto vacío (como está ahora), la app funciona igual, pero solo
   guarda los datos en este celular, sin sincronizar con otros.
   ========================================================================= */

const supabaseConfig = {
  supabaseUrl: "https://uhaukxatblcwejtiqiaz.supabase.co",
  supabaseAnonKey: "sb_publishable_HpExw8qsQYrzJ8j4ABn6rA_VkU-PFVY"
};