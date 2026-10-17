# CUDA routing implementation status

- Fork: `charleslai2000/pi-lsp-extension`
- Base HEAD: `39d56f0cdaf4b5e77ee038f0670de14cd19e228d`
- Local branch: `main` (no commit/push made)

## Implemented

`lsp-core.ts` maps `.cu` and `.cuh` to language ID `cuda` and adds both suffixes to the existing `clangd` server configuration. The server ID remains `clangd`; the manager keys clients by server ID + root, so CUDA and C++ documents with the same root reuse the same client. Existing `.c/.h/.cc/.cpp/.cxx/.hpp/.hh` mappings are unchanged.

There is no schema-supported custom suffix-to-language/server registry: `.pi/settings.json` can override known server commands, arguments, environment, and root markers, but suffix routing is in `LANGUAGE_IDS` and `LSP_SERVERS`. The clangd root resolver now honors the configured `rootMarkers`, allowing `.git` for repositories where CUDA files live below a JIT subtree with no build marker. This is covered by a test. No new LSP extension/server was introduced.

## Source route and original defect

`path.extname(file)` → `LANGUAGE_IDS[ext]` selects the document `languageId` in `LSPManager.langId()`; `getServerConfigsForFile()` selects server configs whose `extensions` contain the suffix; `getClientsForFile()` resolves a project root and initializes/reuses a client keyed by server ID + root; `initClient()` spawns clangd and initializes LSP; `loadFile()` opens/updates the document; `getDocumentSymbols()`, `getDefinition()`, `getReferences()`, `getHover()`, and `touchFileAndWait()` dispatch their operations.

Before the patch, `.cu/.cuh` were absent from both the language-ID table and clangd's extension list, so no clangd config matched and the operation path fell back or reported unsupported. After adding the suffixes, root discovery was the next obstacle: the SGLang JIT subtree has no `CMakeLists.txt`, `Makefile`, `compile_commands.json`, or `compile_flags.txt` marker. Honoring explicit `rootMarkers` solves that without changing default C++ root behavior.

## Compilation database and clangd

SGLang has no checked-in/current root `compile_commands.json`. Its supported CMake path is `sgl-kernel/Makefile:ln`, which enables `-DCMAKE_EXPORT_COMPILE_COMMANDS=YES`; the checked-out kernel requires unavailable/uninitialized FetchContent sources, so no full CMake configure/build was run.

For the production-header probe, a one-entry temporary database (not committed, outside both repos) was created at `/tmp/sglang-hadamard-cuda-compdb/compile_commands.json` for `python/sglang/jit_kernel/csrc/fast-hadamard-transform/hadamard_jit.cuh`, with `directory` set to that file's source directory. Flags came from the active SGLang environment and project helper, not guessed values:

- PyTorch `2.9.1+cu128`, CUDA `12.8`;
- `CUDA_HOME=/usr/local/cuda`, resolving to `/usr/local/cuda-12.8`;
- SGLang JIT `get_jit_cuda_arch()` reports SM 7.0 (700), matching the V100 currently used for the SGLang setup (the host also has an RTX 2060 SM75);
- include roots from `DEFAULT_INCLUDE`, `tvm_ffi.libinfo`, and `torch.utils.cpp_extension.include_paths()`;
- SGLang helper flags include `-DSGL_CUDA_ARCH=700 -std=c++20 -O3 --expt-relaxed-constexpr`; the official SGLang clangd generator explicitly omits NVCC-only `--expt-relaxed-constexpr` because clangd does not recognize it.

Ubuntu clangd 18.1.3 was used. The production-header Pi-manager request returned actual CUDA symbols, hover signatures, definitions, references, and diagnostics. A direct `clang++-18 -xcuda` parse of the production header with SGLang-derived SM70/include flags also exited 0 (only `#pragma once in main file` warnings); clang++ warned that its latest officially supported CUDA is 12.3 while installed toolkit is 12.8. This version warning and clangd's limited handling of some template/code-action deductions remain constraints; this is not a claim of full NVCC parity.

An older cached Ninja graph exists for `sm70_fp8_e5m2_cache.cu` (NVCC 12.8 / SM70); `ninja -t compdb cuda_compile` extracted its entries. The graph is dated 2026-10-08 and includes unrelated historical external paths, so it was not treated as current authoritative config for the header probe.

## Verification

### Production `.cuh` requests through modified fork's `LSPManager`

Using temporary in-memory server arguments (compile database directory and clang++ query driver) and root marker `.git`:

- Real `hadamard_jit.cuh`: one initialized client, server ID `clangd`, root SGLang repository; `documentSymbol` returned `fast_hadamard_transform_kernel` (line 121) and other templates.
- `hover` on `fast_hadamard_transform_kernel`: returned the template and `void` signature with `HadamardParamsBase params` (line 121).
- `goToDefinition` on that symbol returned its actual definition; `findReferences` returned the definition and real launch sites at lines 204 and 213.
- `hover` on `fast_hadamard_transform_cuda` returned its `HadamardParamsBase&` and `DLDevice` template signature (line 225); references included the definition and actual call at line 425.
- Diagnostics responded with two non-error unused-include hints (`static_switch.h`, `algorithm`); no CUDA parse errors were reported for that header.
- The related real `fast_hadamard_transform_common.h` was also routed to the same clangd root and returned symbols/diagnostics.

This proves A, B (same-file definition), D, and E on real production `.cuh`. The selected header does not define a cross-file declaration for the queried kernel; production cross-file reference coverage is not established. A separate temporary, minimal `.cu`/`.cuh` fixture verified clangd could resolve a `.cu` call into a `.cuh` definition, but that is fixture evidence, not a production-source substitute for acceptance item C.

### Regression and project suite

Through the modified fork's manager against real SGLang files:

- C++ `.cpp` → clangd responded, 0 diagnostics on selected bindings source.
- Rust `.rs` → rust-analyzer responded, 0 diagnostics on selected gateway test.
- Python `.py` → Pyright responded; 3 unresolved imports (`torch` and two SGLang modules) in the selected sample.
- Markdown `.md` → markdown server returned the README symbol.

Fork tests:

- `npm run test:tool`: 41 passed, 0 failed.
- `npm run test:detect`: 17 passed, 0 failed.
- `npm run test:integration`: 3 passed, 0 failed, 17 skipped (optional tools unavailable; the Rust integration fixtures skipped because rust-analyzer was unavailable for their temporary crate setup).
- `npm test`: 158 passed, 1 failed. The lone failure is an existing unrelated DevDocs test, `selectDevDocsDocsets: maps supported file types` (expected `['typescript','javascript']`, got `{}`). CUDA route/root tests passed.
- `npx tsc --noEmit`: fails on pre-existing errors in DAP, DevDocs/LSP tool, and Tree-sitter files; no reported errors on the modified CUDA mapping/test lines.
- `git diff --check`: passed.

## Remaining acceptance boundary

CUDA routing, a real production `.cuh` semantic/navigation path, diagnostics, and C++/Rust/Python/Markdown regressions are demonstrated. Production cross-file references (acceptance C) remain unproven; do not claim the entire CUDA acceptance list complete until a real production `.cu`→`.cuh` reference is returned. No production CUDA source was modified. No commit, push, global Pi package update, or SGLang project configuration change is part of this branch work.
