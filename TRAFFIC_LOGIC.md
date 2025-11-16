# Funcționalitate Semafor - Specificații

## Modul AUTOMATIC (Adaptiv)
- **Stare inițială**: Sistemul pornește cu o "linie verde" implicită (Car sau Pedestrian) - setată în settings
- **Timer infinit**: Când e pe linie verde implicită, timer-ul e infinit (999) - sistemul așteaptă detecție
- **Tranziție la detectare**: 
  - Dacă detectează cerere din partea opusă (ex: Car e verde, dar detectează pieton), începe tranziția:
  - **Secvență completă**: Car Green (infinit) → Car Yellow (3s) → All Red (2s) → Ped Green (10s) → Ped Red Stop (3s) → All Red (2s) → Car Green (infinit)
  - Sau invers dacă Pedestrian e linia verde implicită
- **Fără detecție**: Dacă nu detectează nimic, rămâne pe verde infinit
- **Reset detecții**: Detecțiile se resetează automat după ce sunt procesate

## Modul MANUAL (Ciclu Fix)
- **Ciclu continuu**: Rulează un ciclu fix, fără detecție
- **Secvență fixă**: Car Green (15s) → Car Yellow (3s) → All Red (2s) → Ped Green (10s) → Ped Red Stop (3s) → All Red (2s) → repeat
- **Fără oprire**: Nu se oprește, rulează continuu până când se schimbă modul

## Modul OVERRIDE (Manual Forțat)
- **Control manual**: Operatorul forțează manual o stare (ex: verde mașini, roșu pietoni)
- **Timer de siguranță**: După un timp setat, revine automat la modul anterior
- **Anulare manuală**: Poate fi anulat manual pentru a reveni imediat la modul anterior

## Tranziții de Siguranță
- **All Red obligatoriu**: Între orice schimbare de fază principală (Car ↔ Ped), există un All Red de siguranță
- **Yellow pentru mașini**: Mașinile au fază galbenă înainte de roșu
- **Red Stop pentru pietoni**: Pietonii au fază "Don't Walk" (roșu) înainte de a reveni la verde mașini

## Detecție
- **YOLO + FLIR + Inductive Loops**: Sistemul folosește multiple surse de detecție
- **Doar în Automatic**: Detecțiile funcționează doar în modul Automatic
- **Reset automat**: După procesare, detecțiile se resetează

