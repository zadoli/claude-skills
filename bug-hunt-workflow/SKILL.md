---
name: bug-hunt-workflow
description: Use when the user wants a codebase, module, or large diff searched for bugs thoroughly — e.g. "keress hibákat", "bug hunt", "hibakeresés a kódbázisban", "nézd át hibákra az egész repót", "audit this code for bugs", "/bug-hunt-workflow". Splits the code into chunks, gives each chunk its own clean-context hunter agent, then has fresh skeptic agents try to refute every finding, all orchestrated by a Workflow script so the plan never gets summarized away. Not for reviewing a single small change (use code-review) or diagnosing one known bug (use diagnosing-bugs).
---

# Bug Hunt Workflow

## Miért így

Egyetlen agent egy nagy kódbázison rosszul teljesít: minden olvasott fájl ugyanabba a kontextusba kerül, tömörítéskor részletek vesznek el, a saját találatait elfogultan ellenőrzi, és ~15 bug után „késznek" érzi a munkát. (Anthropic mérése: 70 elrejtett bugból egy agent 14–27-et, a workflow 66-ot talált.)

Ez a skill a három hibát külön-külön kezeli:

1. **Darabolás** – minden kódszelet saját, üres kontextusú *hunter* agentet kap.
2. **Ellenvélemény** – minden találatot egy *friss skeptic* agent próbál megcáfolni, aki nem ő írta, nincs oka védeni.
3. **A terv kódban él** – a fázisok közti adatátadást a `workflow.js` program végzi, nem a fő agent kontextusa, így semmi nem „tömörítődik el". A fő agent közben szabad marad.

## Lépések

### 1. Hatókör tisztázása (inline, a fő agentben)

- Gyökér: a felhasználó által megadott mappa, különben a working directory.
- Mód: **teljes kódbázis** (alapértelmezés) vagy **csak a változások** (`git diff --name-only <base>...HEAD` + nem commitolt fájlok), ha a felhasználó PR-t / branchet / „a mostani változtatásokat" említi.
- Fókusz (opcionális): ha a felhasználó megnevez valamit („biztonsági hibák", „konkurencia", „pénzkezelés"), add át `focus`-ként.

### 2. Felderítés és darabolás

- Listázd a forrásfájlokat (`git ls-files`, ha git repo), soronként számolva (`wc -l`).
- **Hagyd ki:** vendor/`node_modules`, build output (`dist`, `target`, `bin`, `obj`), generált kód, lockfile-ok, minified fájlok, bináris/asset fájlok, migrációs snapshotok. A teszteket alapból hagyd ki, kivéve ha a felhasználó kéri.
- **Soha ne vedd be és ne nyisd meg** a `.env*` fájlokat (globális szabály).
- Csoportosítsd **modul/könyvtár szerint**, hogy az összetartozó kód egy szeletbe kerüljön. Cél szeletméret: **~1500–3000 sor, max ~15 fájl**. Egy túl nagy fájl lehet egyedül egy szelet.
- Minden szelet: `{ id: "<rövid-név>", files: ["relatív/út", ...], note: "<mi ez a modul, 1 mondat>" }`.

### 3. Költség-megerősítés

Mutasd meg a felhasználónak a szelettervet (szeletek száma, összes sor, kihagyott részek) és a becslést: hozzávetőleg **szeletenként 150–300k token** a hunt + refute fázisra együtt (a súlyos/külső találatok 3 fős cáfoló panelje benne van; `escalateAll: true` kb. megduplázza a refute részt).
- **≤ 8 szelet:** mehet kérdés nélkül (a skill meghívása maga a beleegyezés).
- **> 8 szelet:** kérdezz rá röviden, induljon-e így, vagy szűkítsen-e.

### 4. Workflow indítása

Olvasd be a skill mappájában lévő `workflow.js`-t (Read), és a teljes tartalmát **változatlanul** add át `script`-ként:

```
Workflow({
  script: "<a workflow.js teljes tartalma>",
  args: { root: "<abszolút gyökér>", chunks: [...], focus: "<opcionális>" }
})
```

- A `scriptPath` ezzel a fájllal **nem működik** (csak a session mappáiból vagy a Workflow által korábban visszaadott útvonalról tölt be), ezért ne azzal próbálkozz.
- Az `args`-ot valódi JSON objektumként add át, ne stringként.
- Diff-módban a `focus` mondja meg a huntereknek, hogy előbb `git diff <merge-base> -- <fájl>`-t futtassanak, és csak a változásban vagy az általa elrontott kódban lévő hibát jelentsék.
- **Cáfolás (automatikus):** minden találatot alapból **1** cáfoló agent ellenőriz. **3 cáfoló agentből álló panel**, mindegyik más szempontból (`standard` / `trace`: végigköveti a kódútvonalat a DB-írásig vagy más repóig / `crosscheck`: összeveti a dokumentációval, a PROD/DEV párral, a tesztekkel), akkor indul, ha a találat `critical`/`high` súlyosságú, vagy a hunter `external_dependency: true`-t jelzett, mert az állítás repón kívüli kódon vagy adaton múlik. Ugyanaz a prompt háromszor nem ér meg ennyit: többnyire ugyanazt a felületes ellenőrzést adja.
- `escalateAll: true`: minden találat panelt kap („alaposan", „audit", „biztosra" kérésnél).
- **Csak cáfolás:** ha egy korábbi futás találatait kell újra ellenőrizni, `chunks` helyett `findings: [...]` adható át, a korábbi találatobjektumokkal. A titkokat (tokenek, `sig=`) előtte takard ki.
- Indítás után a felhasználóval tovább beszélgethetsz; az eredmény task-notification-ként érkezik. **Ne találd ki előre az eredményt.**

**Ha a `Workflow` tool nem elérhető:** ugyanezt az `Agent` toollal csináld – minden szeletre egy hunter agent párhuzamosan egy üzenetben, majd minden találatra egy új, független cáfoló agent (súlyos vagy külső kódtól függő találatnál 3 fős panel, a `workflow.js` promptjaival és szempontjaival, ugyanazzal a `disputed` szabállyal). A hunter eredményeket csak strukturált listaként tartsd meg, ne olvasd újra a kódot a fő kontextusban.

### 5. Riport

A workflow visszatérési értéke: `{ confirmed, disputed, uncertain, refuted, coverage }`. Minden találatban benne van a `votes` (a szavazatok `lens` mezővel) és a `panel` (kapott-e panelt).

1. **Ellenőrizd a lefedettséget:** ha egy szelet `failed`, vagy `unread` nem üres, mondd ki, és ajánld fel ezek újrafuttatását egy kisebb workflow-val (csak az érintett szeletekkel). Ne állítsd, hogy minden át lett nézve, ha nem.
2. **A vitatott találatokat (`disputed`) te döntöd el.** Vitatott az a találat, amelyet legalább egy cáfoló megcáfolt, egy másik pedig megerősített. Ezt **soha nem dönti el a többség**, mert egy alaposan végigkövetett cáfolat leszavazható a felületesebb megerősítésekkel. Olvasd el a cáfoló `counter_evidence`-ét, és a hivatkozott `fájl:sor` helyeket ellenőrizd magad néhány célzott Grep/Read hívással. Ezután sorold a találatot a megerősítettek vagy a megcáfoltak közé, és egy mondatban írd le, mi döntötte el. Ha sok a vitatott találat (> ~5), ezt a lépést egy subagent is elvégezheti.
3. **Megerősített bugok** súlyosság szerint, táblázatban: súlyosság · `fájl:sor` (kattintható link) · cím · trigger (1 mondat). Jelöld, melyik kapott panelt.
4. **Bizonytalanok** külön, rövid indoklással (mitől függ).
5. **Megcáfoltak** csak darabszámmal és egy sorban, mi volt a leggyakoribb cáfolási ok – ne listázd teljesen, hacsak nem kérik.
6. Összegzés: hány szelet, hány nyers találat → hány maradt meg (ebből hány vitatottat döntöttél el, és melyik irányba).

Hosszabb riportnál (> ~10 megerősített bug) ajánld fel, hogy fájlba (`bug-hunt-report-<dátum>.md`) vagy Artifactba írod.

### 6. Javítás – csak kérésre

A skill **nem módosít kódot**. Ha a felhasználó javítást kér, egyenként vagy kis csoportokban javítsd, a skeptic `counter_evidence`-ét is figyelembe véve.

## Tippek

- Második kör („loop-until-dry"): ha a felhasználó maximális alaposságot kér, a megerősített/megcáfolt találatokat `focus`-ba sűrítve („ezeket már ismerjük: …, keress MÁST") futtasd újra ugyanazokat a szeleteket; álljon meg, ha egy kör nem hoz új megerősített bugot.
- Nagyon nagy repónál előbb ajánld fel a szűkítést (legkritikusabb modulok, legutóbb változott fájlok).
