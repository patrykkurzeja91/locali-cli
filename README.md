# mini-tms

> Lekkie, niezależne narzędzie CLI do synchronizacji plików tłumaczeń (`i18n`) pomiędzy kodem aplikacji a serwerem **Mini-TMS**. Działa analogicznie do Crowdin CLI / Lokalise CLI, pobierając teksty w procesach CI/CD lub wysyłając nowe klucze z lokalnego środowiska deweloperskiego.

Zero zewnętrznych zależności w runtime — wbudowany silnik serializacji, parsowania i walidacji tokenów.

---

## 🚀 Szybki start (Quick Start)

### 1. Pobieranie tłumaczeń w CI/CD (np. GitHub Actions)
Nie musisz nawet instalować paczki na stałe — wystarczy `npx`:

```bash
npx --yes mini-tms pull
```

Zmienne środowiskowe:
- `MINI_TMS_API_URL` — adres URL serwera API (np. `https://translations-api.devwizards.pl`)
- `MINI_TMS_TOKEN` — token API z uprawnieniem do odczytu (`mtms_...`)

### 2. Instalacja w projekcie jako zależność developerska

```bash
pnpm add -D mini-tms
# lub
npm install --save-dev mini-tms
# lub
yarn add -D mini-tms
```

Dodaj skrót do `package.json`:
```json
{
  "scripts": {
    "i18n:pull": "mini-tms pull",
    "i18n:push": "mini-tms push",
    "i18n:status": "mini-tms status"
  }
}
```

---

## ⚙️ Konfiguracja (`i18n.config.json`)

W katalogu głównym projektu utwórz plik `i18n.config.json`:

```json
{
  "projectId": "default",
  "sourceLanguage": "pl",
  "targetLanguages": ["en", "fr", "de"],
  "localesDir": "src/locales",
  "fileStructure": "{localesDir}/{lang}.json",
  "fileFormat": "nested",
  "defaultNamespace": "common"
}
```

### Opcje konfiguracji:
- `projectId` — identyfikator slug projektu w Mini-TMS.
- `sourceLanguage` — kod języka źródłowego (np. `pl`).
- `targetLanguages` — tablica kodów języków docelowych.
- `localesDir` — katalog z plikami tłumaczeń.
- `fileStructure`:
  - `{localesDir}/{lang}.json` (płaski układ per język, np. `src/locales/pl.json`)
  - `{localesDir}/{lang}/{namespace}.json` (układ z podziałem na przestrzenie nazw, np. `src/locales/pl/common.json`)
- `fileFormat` — `nested` (zagnieżdżone obiekty JSON) lub `flat` (klucze rozdzielane kropkami).

---

## 🛠️ Dostępne polecenia

### `mini-tms pull`
Pobiera najnowsze opublikowane tłumaczenia z serwera i zapisuje je w lokalnych plikach JSON.
```bash
mini-tms pull
mini-tms pull --lang en,fr        # Pobierz tylko wybrane języki
mini-tms pull --dry-run          # Podgląd zmian bez modyfikacji dysku
```

### `mini-tms push`
Skanuje lokalne pliki języka źródłowego i wysyła nowe klucze do serwera Mini-TMS.
```bash
mini-tms push
mini-tms push --dry-run          # Podgląd wykrytych nowych kluczy
mini-tms push --update-source    # Zaktualizuj także istniejące teksty źródłowe
```

### `mini-tms status`
Porównuje lokalne pliki z bazą na serwerze i raportuje brakujące teksty oraz rozbieżności.
```bash
mini-tms status
```

### `mini-tms validate`
Sprawdza poprawność składni plików JSON, formatu kluczy oraz integralności tokenów interpolacji.
```bash
mini-tms validate
```

---

## 🔒 Bezpieczeństwo i tokeny API

Tokeny API generujesz w panelu administracyjnym Mini-TMS w zakładce **Ustawienia projektu -> Tokeny API & CI/CD**:
- Dla procesów budowania w **CI/CD** wybierz uprawnienie **`read (Tylko odczyt)`** — taki token nie pozwala na modyfikację ani usunięcie żadnych danych na serwerze.
- W repozytorium zapisz token jako tajną zmienną środowiskową (np. `MINI_TMS_TOKEN` w **GitHub Secrets**).

---

## 📄 Licencja

MIT © Patryk Kurzeja
