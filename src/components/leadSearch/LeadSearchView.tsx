import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';
import { useDemo } from '../../state/demo';
import { useLeadSearch } from './LeadSearchProvider';
import { RunView } from './RunView';
import { SearchForm } from './SearchForm';

/** Menüpunkt „Lead-Suche“: erst das Suchprofil, dann der Lauf. */
export function LeadSearchView() {
  const { state } = useDemo();
  const { config } = useLeadSearch();
  const run = state.leadSearch.run;
  const runId = run?.id ?? null;

  // Formular und Lauf sind zwei Seiten – jede beginnt oben (mobil war das Formular evtl. weit gescrollt).
  // Mit Klammern: Neuere Browser (Chrome 154) geben bei scrollTo einen Wert zurück – React hielt ihn für eine
  // Aufräumfunktion und stürzte beim Verlassen der Lead-Suche ab („l is not a function“).
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [runId]);

  return (
    <AnimatePresence mode="wait" initial={false}>
      {run ? (
        <motion.div
          key={`run-${run.id}`}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.45 }}
        >
          <RunView run={run} />
        </motion.div>
      ) : (
        <motion.div
          key="form"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.45 }}
        >
          {/* Neu aufbauen, sobald die Konfiguration da ist – dann stimmen die Voreinstellungen. */}
          <SearchForm key={config.status} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
