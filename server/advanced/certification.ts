export type CertStatus = 'CERTIFIED' | 'PASSED_LOCAL' | 'BLOCKED' | 'BLOCKED_SANDBOX' | 'FAILED' | 'SKIPPED' | 'NOT_RUN';

export interface CommandProof {
  isolationRequested: 'required' | 'local';
  dockerRan: boolean;
  evidence: 'live' | 'test-double' | 'absent';
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  denied: boolean;
  simulated: boolean;
}

/** CERTIFIED seulement si Docker a réellement exécuté la commande, hors double de test. */
export function commandVerdict(proof: CommandProof): CertStatus {
  if (proof.denied || proof.simulated || proof.evidence === 'test-double') return 'BLOCKED';
  if (proof.isolationRequested === 'required' && (!proof.dockerRan || proof.evidence !== 'live')) return 'BLOCKED_SANDBOX';
  if (proof.timedOut || proof.truncated || proof.exitCode !== 0) return 'FAILED';
  if (proof.dockerRan && proof.evidence === 'live') return 'CERTIFIED';
  return 'PASSED_LOCAL';
}

export interface ProjectProof extends CommandProof {
  modelInvoked: boolean;
  testsWereRed: boolean;
  testFileUnchanged: boolean;
  modelCalls: number;
}

/** Un mock, un test unitaire ou un runtime local ne peuvent pas produire CERTIFIED. */
export function projectVerdict(proof: ProjectProof): CertStatus {
  if (proof.simulated) return 'BLOCKED';
  if (proof.isolationRequested === 'required' && proof.evidence !== 'live') return 'BLOCKED_SANDBOX';
  if (proof.denied) return 'BLOCKED';
  if (!proof.modelInvoked) return 'NOT_RUN';
  if (!proof.testsWereRed || !proof.testFileUnchanged || proof.modelCalls < 1 || proof.timedOut || proof.truncated || proof.exitCode !== 0) return 'FAILED';
  return commandVerdict(proof);
}

export interface ScenarioPlan {
  id: 'node-typescript' | 'react' | 'next' | 'python' | 'android-gradle';
  title: string;
  status: CertStatus;
  reason: string;
  certified: false | true;
  files: { path: string; contents: string }[];
  testCommand: string | null;
  goal: string;
}

const nodeFiles = [
  { path: 'package.json', contents: '{"name":"tax-fixture","private":true,"type":"module"}\n' },
  { path: 'src/tax.ts', contents: 'export function tax(amount: number): number {\n  return Math.round(amount * 0.1);\n}\n' },
  { path: 'tests/tax.test.ts', contents: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { tax } from '../src/tax.ts';\n\ntest('taxe 20 pour cent', () => {\n  assert.equal(tax(100), 20);\n});\n" },
];
const pythonFiles = [
  { path: 'tax.py', contents: 'def tax(amount):\n    return round(amount * 0.1)\n' },
  { path: 'tests/test_tax.py', contents: 'import unittest\nfrom tax import tax\n\nclass TaxTest(unittest.TestCase):\n    def test_rate(self):\n        self.assertEqual(tax(100), 20)\n\nif __name__ == "__main__":\n    unittest.main()\n' },
];
const reactFiles = [
  { path: 'src/Price.jsx', contents: 'export function priceLabel(cents) {\n  return `${cents / 10} EUR`;\n}\n' },
];
const nextFiles = [
  { path: 'app/page.jsx', contents: 'export default function Page() {\n  return "USD";\n}\n' },
];
const androidFiles = [
  { path: 'settings.gradle', contents: "rootProject.name = 'fixture'\n" },
  { path: 'app/src/main/java/fixture/Price.java', contents: 'package fixture;\npublic final class Price {\n  public static int unit() { return 1; }\n}\n' },
];

export function certificationPlan(env: { node: boolean; python: boolean; react: boolean; next: boolean; android: boolean; docker: boolean }, results: Partial<Record<ScenarioPlan['id'], ProjectProof>> = {}): ScenarioPlan[] {
  const nodeProof = results['node-typescript'];
  const plans: ScenarioPlan[] = [
    {
      id: 'node-typescript', title: 'TypeScript / Node.js', files: nodeFiles, goal: 'La fonction tax doit calculer 20 pour cent du montant, arrondi à l’entier le plus proche.',
      testCommand: env.node ? 'node --experimental-strip-types --test tests/tax.test.ts' : null,
      status: nodeProof ? projectVerdict(nodeProof) : 'NOT_RUN',
      reason: nodeProof ? 'Preuve fournie par une exécution, pas par un mock de succès.' : 'Scénario préparable. Le correctif modèle n’est pas lancé par la suite unitaire.',
      certified: nodeProof ? projectVerdict(nodeProof) === 'CERTIFIED' : false,
    },
    {
      id: 'react', title: 'React', files: reactFiles, goal: 'Le libellé de prix doit exprimer des euros à partir des centimes.', testCommand: null,
      status: 'SKIPPED', reason: env.react ? 'React est présent dans le produit, pas dans un projet de certification isolé. Pas d’installation réseau implicite.' : 'React non installé dans le projet de certification. Pas d’installation réseau implicite.', certified: false,
    },
    {
      id: 'next', title: 'Next.js', files: nextFiles, goal: 'La page doit afficher EUR.', testCommand: null,
      status: 'SKIPPED', reason: 'Next.js absent. Pas d’installation réseau implicite et pas de succès simulé.', certified: false,
    },
    {
      id: 'python', title: 'Python', files: pythonFiles, goal: 'La fonction tax doit retourner 20 pour cent du montant.', testCommand: env.python ? 'python3 -m unittest tests/test_tax.py' : null,
      status: 'SKIPPED', reason: env.python ? 'Projet préparable et tests rouges vérifiables. Correctif modèle non lancé afin de limiter les appels payants.' : 'Python absent.', certified: false,
    },
    {
      id: 'android-gradle', title: 'Android Gradle', files: androidFiles, goal: 'Price.unit doit retourner 2.', testCommand: null,
      status: 'BLOCKED', reason: env.android ? 'SDK détecté, correctif non lancé.' : 'SDK Android ou Gradle absent. Aucun PASS simulé.', certified: false,
    },
  ];
  if (!env.docker) {
    for (const plan of plans) {
      if (plan.status === 'CERTIFIED') {
        plan.status = 'PASSED_LOCAL';
        plan.certified = false;
        plan.reason = 'Docker absent : un succès local n’est pas une isolation certifiée.';
      }
    }
  }
  return plans;
}
