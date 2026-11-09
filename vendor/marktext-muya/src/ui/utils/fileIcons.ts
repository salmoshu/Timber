// Timber keeps language selection text-only so the embedded editor has no git-only icon dependency.
const fileIcons = {
    getClassByName: (_name: string): string | null => null,
    getClassByLanguage: (_language: string): string | null => null,
};

export default fileIcons;
