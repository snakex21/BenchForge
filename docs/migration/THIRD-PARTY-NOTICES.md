# Experimental Go / frontend distribution notices

BenchForge's original MIT license remains in the repository root. The Go binaries use the Go runtime/standard library; its BSD-style license is retained in `licenses/Go-LICENSE.txt`.

The compiled read-only frontend reuses the project's installed React, React DOM, Scheduler, Zustand and Tailwind CSS packages. Their MIT license texts are retained under `licenses/`. The existing frontend's icon assets and locale catalogs are reused from this same BenchForge repository. Build-time tooling is not a required runtime service for the Go viewer. No SuperCli implementation code was copied into these experimental packages.

The SQL reader is not part of this reviewed branch; no SQLite driver or its dependencies are included here.
