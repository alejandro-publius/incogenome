# DoseDNA

A privacy-first pharmacogenomics web app. Load a consumer DNA file
(23andMe / AncestryDNA); it's read **entirely in your browser**, mapped to
drug-metabolism status, and shown as plain-language medication guidance.
Your raw DNA never leaves your device.

> Before you take a new medication, see how your body may handle it —
> based on your DNA, without your genome ever leaving your device.

## Status
Early build. See **[BUILD_SPEC.md](./BUILD_SPEC.md)** for the full
architecture, genomics knowledge base, and build plan.

## How it works
- DNA parsing and all variant→result logic run locally in a Web Worker.
- Medication guidance is bundled and works offline.
- Only an anonymized `gene + phenotype + drug` is ever sent for plain-language
  wording — and even that is precomputed. No DNA, genotypes, or identifiers
  leave the device.

## Not medical advice
Informational only. Confirm any medication decision with a clinician or
pharmacist.

## Develop
See `BUILD_SPEC.md` Section 16 for the step-by-step build order.
