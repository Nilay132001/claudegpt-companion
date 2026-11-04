// Folds a name the way a case-insensitive APFS volume might treat it as equal (spec §7.2, M2 ruling 2).
// NFKC maps compatibility look-alikes (Kelvin sign, long s, fullwidth) to ASCII;
// upper then lower catches letters whose lower case alone does not fold.
export function foldName(s: string): string {
  return s.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}
