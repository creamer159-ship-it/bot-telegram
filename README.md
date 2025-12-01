# Bot Telegram – zarządzanie wiadomościami

Bot służy do wysyłania, edytowania i kasowania postów, a także do planowania wiadomości z użyciem harmonogramu CRON (6 pól z sekundami).

## /help
Komenda `/help` wyświetla czytelny panel z opisem bota, listą najważniejszych komend oraz przykładowym użyciem `/schedule`. Na końcu wiadomości znajduje się wskazówka, że pełen opis formatu CRON można uzyskać komendą `/cron_help`. To najlepszy punkt startowy dla osób, które chcą szybko sprawdzić możliwości bota.

## /test_post
Komenda `/test_post` wysyła przykładową wiadomość: „To jest testowy post bota do edycji i kasowania. Użyj /edit_post lub /delete_post z odpowiednim ID.”. Służy do ćwiczenia komend `/edit_post` oraz `/delete_post`. Identifikator `message_id` tej wiadomości pojawi się w logach (np. podczas `npm run dev`), co ułatwia eksperymenty.

## /list_posts
Komenda `/list_posts [limit]` wyświetla ostatnie wiadomości wysłane przez bota w bieżącym czacie (domyślnie 10 pozycji, maksymalnie 50). Dla każdej wiadomości pokazuje `message_id`, źródło (np. `ping`, `schedule`) i skróconą treść oraz dodaje przyciski „✏️ Edytuj” i „🗑 Usuń”. Dzięki temu można albo kliknąć przycisk, albo skopiować ID. Przykład ograniczenia listy do pięciu pozycji: `/list_posts 5`.

## /list_jobs
`/list_jobs` wypisuje wszystkie aktywne zadania Cron utworzone komendą `/schedule` w bieżącym czacie. Każdy wiersz zawiera numer zadania (`#ID`), wyrażenie cron oraz skrócony opis wiadomości, np. `#3 cron: 0 0 9 * * * — Poranny post`. Dzięki temu wiadomo, które zadania działają w tle i jakie ID należy podać do anulowania.

## /cancel_job
Komenda `/cancel_job <id>` zatrzymuje zadanie utworzone przez `/schedule`. Jeśli podasz nieistniejący numer, bot zwróci komunikat o błędzie. Po zatrzymaniu zadania bot potwierdza komunikatem „Zadanie #<id> zostało zatrzymane.”.

## /cron_help
`/cron_help` opisuje format CRON z sześcioma polami: `sekunda minuta godzina dzień_miesiąca miesiąc dzień_tygodnia`. Dla każdego pola podano zakresy, a także omówiono symbole `*`, `*/10`, listy (`1,15`) i zakresy (`1-5`). W wiadomości znajdują się gotowe przykłady:

- `*/10 * * * * *` – co 10 sekund,
- `0 */5 * * * *` – co 5 minut,
- `0 0 9 * * *` – codziennie o 9:00,
- `0 0 18 * * 1-5` – w dni robocze o 18:00.

Na końcu przypomniana jest pełna składnia komendy: `/schedule "CRON" Treść`, np. `/schedule "*/10 * * * * *" Hello`.

## /edit_post
Komenda `/edit_post <message_id> <nowy_tekst>` nadal działa jak dotąd (np. `/edit_post 12345 Nowa treść ogłoszenia`). Dodatkowo można:

- odpowiedzieć na wiadomość wysłaną przez bota i wpisać `/edit_post Nowy tekst`, aby nie przepisywać `message_id`,
- kliknąć „✏️ Edytuj” pod listą wygenerowaną przez `/list_posts` – bot poprosi wówczas o nową treść w następnym komunikacie (tzw. sesja edycji).

Każda udana edycja aktualizuje wpis w `message-store`.

## /delete_post
Komenda `/delete_post <message_id>` usuwa wiadomość wysłaną przez bota i oznacza ją jako usuniętą w pamięci procesu. Teraz można także odpowiedzieć na wiadomość bota samą komendą `/delete_post` albo użyć przycisku „🗑 Usuń” pod wpisem z `/list_posts`. Każda z tych dróg kończy się komunikatem o powodzeniu lub błędzie (np. gdy wskazana wiadomość nie należy do bota).

## Jak znaleźć `message_id`
Każda wiadomość wysyłana przez bota jest logowana w konsoli w formacie `[message-store] Zapisano wiadomość <ID> w czacie <CHAT_ID> (źródło: <źródło>)`. Nadal można odczytać numer z logów, ale w codziennym użyciu najwygodniej jest:

- wyświetlić listę `/list_posts` i skorzystać z przycisków pod konkretnym wpisem,
- albo po prostu odpowiedzieć (`reply`) na wiadomość bota komendą `/edit_post ...` lub `/delete_post`.

Dzięki temu zarządzanie postami nie wymaga ręcznego przepisywania identyfikatorów.

## Uruchamianie i deployment

- **Lokalnie (tylko bot):** `npm run dev` – uruchamia bota przez `tsx` z automatycznym reloadem przy zmianach kodu.
- **Lokalnie z panelem:** `npm run dev:panel` – ustawia `START_PANEL=true`, więc bot i panel działa w jednym procesie dla testów.
- **Kompilacja:** `npm run build` – transpiluje całość do `dist/` (w tym `dist/index.js` i `dist/panelServer.js`), gotowych do uruchomienia w Node.js.
- **Produkcja (tylko bot):** `npm start` – uruchamia skompilowanego bota z `dist/index.js`; panel nie startuje, chyba że jawnie ustawisz `START_PANEL=true`.
- **Panel oddzielnie (opcjonalnie):** `npm run panel` – po `npm run build` uruchamia tylko serwer panelu (przydatne do monitorowania zaplanowanych zadań).

### Zmienne środowiskowe

- `BOT_TOKEN` – wymagany token bota Telegram.
- `CHANNEL_ID` – domyślny identyfikator kanału do komend typu `/schedule_channel`; jeśli go nie ma, bot informuje o braku konfiguracji.
- `START_PANEL` – ustaw na `true`, aby razem z botem wystartował panel HTTP; w typowym `npm start` pozostaw pustą wartość, żeby panel pozostał wyłączony.
