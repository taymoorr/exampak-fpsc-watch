# exampak-fpsc-watch

Watches the public FPSC website (fpsc.gov.pk) for new notices, for [ExamPak](https://exampak.com).

Every 10 minutes a GitHub Action (`.github/workflows/watch.yml`) runs `watch.mjs`, which:

1. opens the FPSC pages that matter to General Recruitment candidates (jobs, syllabus, merit lists, shortlisting,
   documents required, failure cases, nominations, written and final results, answer keys, test schedules,
   interview programmes, home page and public notices);
2. works out what each document is from the page it is on and its file name;
3. tells exampak.com about anything new (`POST https://exampak.com/api/fpsc-event`, with a password kept in the
   GitHub secret `EXAMPAK_KEY`);
4. remembers what it has seen in `state.json`.

A new file is not always news: FPSC sometimes re-uploads old lists under new file numbers. Documents are grouped by
type, case and year, so a re-upload is recorded as a "repeat" and does not raise an alert.

It reads only public pages and sends only FPSC's own public file names and links. There are no secrets in this
repository. `fpsc-intermediate.pem` is the public intermediate certificate that FPSC's server forgets to send; with
it, certificate checking stays switched on.

Run it yourself without sending anything: `node watch.mjs --dry` (Node 20 or newer).

ExamPak is independent and not part of FPSC.
