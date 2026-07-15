// superharness flavor-code plugin
// Registers the superharness skill root so that go, brainstorm, tdd, etc.
// are discovered under the /superharness namespace.
export function activate(context) {
  context.registerSkillRoot("superharness", "./skills");
}
