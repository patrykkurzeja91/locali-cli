# locali

> Lekkie, niezależne narzędzie CLI do synchronizacji plików tłumaczeń (`i18n`) pomiędzy kodem aplikacji a panelem **Locali**. Działa analogicznie do Crowdin CLI / Lokalise CLI, pobierając teksty w procesach CI/CD lub wysyłając nowe klucze z lokalnego środowiska deweloperskiego.

Zero zewnętrznych zależności w runtime — wbudowany silnik serializacji, parsowania i walidacji tokenów interpolacji.

---

## 🚀 Szybki start (Quick Start)

### 1. Pobieranie tłumaczeń w CI/CD (np. GitHub Actions)
Nie musisz nawet instalować paczki na stałe — wystarczy `npx`:

```bash
npx --yes locali pull
```

Zmienne środowiskowe:
- `LOCALI_API_URL` — adres URL serwera API (np. `https://translations-api.devwizards.pl`, alternatywnie `MINI_TMS_API_URL`)
- `LOCALI_TOKEN` — token API z uprawnieniem do odczytu (`locali_...` lub `mtms_...`)

### 2. Instalacja w projekcie jako zależność developerska

```bash
pnpm add -D locali
# lub
npm install --save-dev locali
# lub
yarn add -D locali
```

Dodaj skrót do `package.json`:
```json
{
  "scripts": {
    "i18n:pull": "locali pull",
    "i18n:push": "locali push",
    "i18n:status": "locali status",
    "i18n:validate": "locali validate"
  }
}
```

---

## ⚙️ Konfiguracja (`locali.config.json` lub `i18n.config.json`)

W katalogu głównym projektu utwórz plik `locali.config.json`:

```json
{
  "projectId": "default",
  "sourceLanguage": "pl",
  "targetLanguages": ["en", "fr", "de"],
  "localesDir": "src/locales",
  "fileStructure": "{localesDir}/{lang}.json",
  "fileFormat": "nested",
  "defaultNamespace": "common",
  "apiBaseUrl": "https://translations-api.devwizards.pl"
}
```

### Opcje konfiguracji:
- `projectId` — identyfikator slug projektu w Locali.
- `sourceLanguage` — kod języka źródłowego (np. `pl`).
- `targetLanguages` — tablica kodów języków docelowych.
- `localesDir` — katalog z plikami tłumaczeń.
- `fileStructure`:
  - `{localesDir}/{lang}.json` (płaski układ per język, np. `src/locales/pl.json`)
  - `{localesDir}/{lang}/{namespace}.json` (układ z podziałem na przestrzenie nazw, np. `src/locales/pl/common.json`)
- `fileFormat` — `nested` (zagnieżdżone obiekty JSON) lub `flat` (klucze rozdzielane kropkami).
- `apiBaseUrl` — opcjonalny adres URL API (jeśli nie podano w zmiennej środowiskowej).

---

## 🛠️ Dostępne polecenia

### `locali pull`
Pobiera najnowsze opublikowane tłumaczenia z serwera i zapisuje je w lokalnych plikach JSON.
```bash
locali pull
locali pull --lang en,fr        # Pobierz tylko wybrane języki
locali pull --dry-run          # Podgląd zmian bez modyfikacji dysku
```

### `locali push`
Skanuje lokalne pliki języka źródłowego i wysyła nowe klucze do serwera.
```bash
locali push
locali push --dry-run          # Podgląd wykrytych nowych kluczy
locali push --update-source    # Zaktualizuj także istniejące teksty źródłowe
```

### `locali status`
Porównuje lokalne pliki z bazą na serwerze i raportuje brakujące teksty oraz rozbieżności.
```bash
locali status
```

### `locali validate`
Sprawdza poprawność składni plików JSON, formatu kluczy oraz integralności tokenów interpolacji.
```bash
locali validate
```

---

## 🔄 Wsteczna kompatybilność
Jeśli korzystałeś wcześniej z `mini-tms`, narzędzie zachowuje pełną kompatybilność:
- Polecenie `mini-tms` jest zachowane jako alias dla `locali`
- Zmienne środowiskowe `MINI_TMS_TOKEN` i `MINI_TMS_API_URL` są automatycznie obsługiwane jako fallback
- Plik `i18n.config.json` jest automatycznie wykrywany, jeśli brak `locali.config.json`
