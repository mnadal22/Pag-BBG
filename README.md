# Terminal de indicadores

Monitor de indicadores de mercado estilo Bloomberg que se actualiza solo y se publica gratis en GitHub Pages.

- **GitHub Actions** baja los datos dos veces al día (18:30 y 09:00, hora de Chile), calcula los derivados y publica el sitio.
- **Fuentes gratis:** FRED (tasas, crédito, macro EE.UU.), Banco Central de Chile (API BDE) y Yahoo Finance (acciones, monedas, materias primas, cripto).
- **Sin servidor ni base de datos:** los datos se publican como JSON estáticos junto a la página.

```
catalog/indicators.yaml   ← el catálogo: aquí agregas indicadores
ingest/                   ← descarga, derivados y snapshot (Python)
web/index.html            ← interfaz (monitor + gráfico)
.github/workflows/        ← automatización
```

## Puesta en marcha (una sola vez)

1. **Crea las keys gratuitas**
   - FRED: crea una cuenta en https://fredaccount.stlouisfed.org/apikeys y pide una API key.
   - Banco Central: crea una cuenta en la BDE y, en "Acceso a la API", aprieta **Habilitar API**
     (https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/index.htm).

2. **Configura los secretos** en *Settings → Secrets and variables → Actions → Secrets*:
   `FRED_API_KEY`, `BCCH_USER` (tu correo de la BDE) y `BCCH_PASS`.

3. **Haz público el repo:** *Settings → General → Danger Zone → Change visibility*.
   Con una cuenta gratis, Pages solo funciona en repos públicos.

4. **Activa Pages:** en *Settings → Pages → Source*, elige **GitHub Actions**.

5. **Opcional:** en *Settings → Secrets and variables → Actions → Variables*, crea
   `SITE_URL` = `https://mnadal22.github.io/Pag-BBG`. Así, si una fuente falla, se reutiliza la última versión publicada.

6. **Primera corrida:** en *Actions → "Actualizar datos y publicar"*, aprieta **Run workflow**.
   Al terminar, el sitio queda en https://mnadal22.github.io/Pag-BBG y desde ahí se actualiza solo.

### Modo privado (opcional)

Si algún día quieres dejar de publicar, crea la variable `PUBLISH` = `false`.
El workflow sigue bajando los datos, pero deja el sitio solo como archivo descargable
(*Actions* → corrida → **Artifacts** → `sitio`). Para verlo, descomprímelo, corre
`python -m http.server 8000` dentro de la carpeta y abre http://localhost:8000.

## Agregar indicadores

Agrega una línea a `catalog/indicators.yaml` y haz push. El workflow corre solo.

```yaml
- {id: UST7Y, name: Tesoro 7Y, cat: Tasas EE.UU., src: fred, code: DGS7, unit: "%"}
```

- Códigos FRED: busca en https://fred.stlouisfed.org; el código aparece junto al título de la serie.
- Códigos del BCCh: usa el buscador de series de la API BDE.
- Tickers de Yahoo: el código que aparece en finance.yahoo.com.
- Derivados: `op: spread | ratio | yoy`, con `args` que pueden ser otros ids, incluidos otros derivados.

El resumen de cada corrida (en *Actions*, al abrir la corrida) muestra qué series fallaron y por qué.
Si un código de BCCh o FRED está mal, ahí lo vas a ver.

## Correr en tu computador

```bash
pip install -r requirements.txt
export FRED_API_KEY=...  BCCH_USER=...  BCCH_PASS=...
python -m ingest.run --out site/data
cp -r web/. site/ && python -m http.server -d site 8000   # abre http://localhost:8000
```

## Notas

- GitHub desactiva los workflows programados de repos públicos tras **60 días sin actividad** en el repo.
  Si pasa, basta con hacer cualquier commit o reactivarlo en *Actions*.
- yfinance no es oficial y a veces falla. Cuando pasa, la serie queda marcada con ● rojo y se usa el último dato publicado.
- Atajos de la interfaz: `/` enfoca el buscador y `Enter` abre el gráfico del primer resultado.
