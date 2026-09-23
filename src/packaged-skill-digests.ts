/**
 * sha256 of every file a release shipped under the CLI-owned skill trees, by
 * skill and path relative to the skill directory. A skill-root `SKILL.md` is
 * hashed without its frontmatter block (`packagedSkillDigest`): releases before
 * 0.17 shipped it with none, and the deploy of the day repaired frontmatter on
 * disk, so only the body is what the CLI provably wrote.
 *
 * Generated from `git ls-tree -r <ref> -- skills/` over all 99 tags
 * through v0.25.0 plus origin/main before the stub (installs from `main`),
 * minus `teamai-wiki` (see PACKAGED_SKILL_FILES). Do not edit by hand; a new
 * release adds nothing here, since the package no longer ships these trees.
 */
export const PACKAGED_SKILL_DIGESTS: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map([
  ['teamai', new Map([
    ['SKILL.md', ['5d3c7629924db1a4b7feb17d75b0a94a804229a6bbee923ba50888a706f328cc', '7002b421f08803ab7c5858b8d69e0c5e37f5d6c42dd6c4ee411796e08d35f1d8']],
    ['references/contribute-member.md', ['2a6a8c3eeee7424f79cb6d3f97d14f8588720f1d570028f5afdd12d6db458355']],
    ['references/join-member.md', ['2f2f823675cea971b2a0360e7c6f090b2397e25702e60cce50bafb2b450ce8c3', '45e56c965fba5fe5f14cfb927c9b18032d19ebf98e524e7c709bcde16862b15a', 'ed2ab1c92680b3412e2ce60d5900f6baba0da896ad92158945ac6115ac939fc2']],
    ['references/manage-admin.md', ['fd31d78724fb35d3bfecf606299c9e907f2a10da275bf06f840780c674584158']],
    ['references/provider-tgit.md', ['df7faedb8beeafeb55a23c2b3d2b99d1421548cf4f8172ed7da0752ef6aeda39']],
    ['references/setup-admin.md', ['4e58bae91bcb3831fd7d2dc0c9f086bb0e985f7d51dd7bc7e753bce1b380816e', 'dae12585f3003f1e6c347f51859de68c7af9baf11b84be63559cb782d122db7b', 'ff9996686f42cc7d7c2a09cb5f254dc0d8fb379fae29dab9046c971dcced543f']],
    ['references/troubleshooting.md', ['78ad122c14f1c5081ef698c880c4a250a99eb7a6ccbb1b39674359e712261fc6']],
    ['references/uninstall.md', ['10a97318e8bc6a94a0413e6d1b1b516b24ab8fd7f52d118cfc0d92c97394b892']],
  ])],
  ['teamai-share-learnings', new Map([
    ['SKILL.md', ['2bfdfa9c4f312424e06544fe104fbf5988cf5a6b3f2289215cbe89fb430d18c0', '7771ec3997b747e4e270818189a1f450cc7e7307cc14c15b42491a2f20e94494', 'a47169735ee710bb38c21fa72e8f647ca2078b1cfd538bad78e30a0806f179c5', 'de28d09f85099943339f3adff3f3e2f180099d18d2963655bb14ca4af4f98bea', 'e7ab73f2258e13b55c91bffdd07975b13fb7a34c84c81215340a8239432f358b']],
  ])],
  ['team-wiki-codebase', new Map([
    ['README.md', ['4e1ab336bfa6d78085572b4e0fc0e345bda0ec2be065279f189a8f2939f242b8', '82945615d4706b2c1b581d2b326c15536be0b8573472c359d1414690f0b2e804', 'd3c7312663caa8cefccd1034127fe7091384b8e603fcd04961f4f30a8ff1fe0e']],
    ['SKILL.md', ['178164fbfd2724cbc581c7e8c16712e41c7928bb8dba7c9ad6b9a3ef50afac2f', '1f5fbdc46873e8baae340b6dfb4e289a74d3706b357db4c7b8eab41971ef95dc', '79f260dda754a5495e027643ae2bd0b3b70ea761b8ce297aee9a66a97ca43da7', 'b2ffc2996f415b5709bf3a75ac5b5d5de52ebb8e866506f5f00aa6730d55c269', 'eb268ad4bf653e77dead394141204d6a20881b0e5a6cb9d5cea33822c7ebd90c']],
    ['references/agents/graph-rag-agent.md', ['d79e52cfec1e131877f7fa28bb14993b937fb643ed6778fde6bf569dbd0ba2d3']],
    ['references/agents/kb-doc-generator.md', ['8dc1f1ef5e5d270223586567629b66333a07c42ae103ac5cdef6c755364587d5']],
    ['references/methodology/phase0-collection.md', ['1061ff28e17aa290dc0942958bac0ea0844b3b830fabda3dd9e03ac32c02b0b0', '89caa5e6e5135b19e39ebf48224a31ae6ea80bbef84c7c2e4cf50b6391220cf6']],
    ['references/methodology/phase1-reverse-engineering.md', ['9d709e09a30ca198020fe7f2470980a4d2f4889a685dc33f71c79f6433110a59']],
    ['references/methodology/phase2-document-types.md', ['62eee3e3290cbc1a4a7c40bcac5e7d8f2100989b438726b867af448dfda67b7b']],
    ['references/methodology/phase3-ai-enhancement.md', ['efe1536f1ea4a2ffeb9ab69409ce1cb172fe8a5b8efb583a46ed69ed976bc6d0']],
    ['references/methodology/phase4-quality.md', ['a7b536ab120a8c4bc3fbd53256675309a399e53b4d0d202abd5df1b82c985754']],
    ['references/templates/project-overview.md', ['296c15c827ae7798bf9f3112b84d1bdd69b0807bb80286cfc78f1a0d956e66ec']],
    ['scripts/scan_repo.py', ['a941f3ac9a260c860cfeded26eb6c6f3d55cc5af748e1e5f673a94278c6a9c36']],
    ['scripts/validate_kb.py', ['c6e08b03b80a60048374637b4de20afdd21b552892e915b8301efb368316522f']],
  ])],
]);
