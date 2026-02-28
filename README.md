<div align="center">
  <img src="./logo.png" alt="ripcord logo" width="160" />
  <p><strong>A lightweight, self-hosted real-time communication platform</strong></p>
</div>

## What is ripcord?

> [!NOTE]
> ripcord is in alpha stage. Bugs, incomplete features and breaking changes are to be expected.

ripcord is a self-hosted communication platform that brings the most important Discord-like features to your own infrastructure. Host voice channels, text chat, and file sharing on your terms—no third-party dependencies, complete data ownership, and full control over your group's communication.

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

Built with amazing open-source technologies:

- [Bun](https://bun.sh)
- [tRPC](https://trpc.io)
- [Mediasoup](https://mediasoup.org)
- [Drizzle ORM](https://orm.drizzle.team)
- [React](https://react.dev)
- [Radix UI](https://www.radix-ui.com)
- [ShadCN UI](https://ui.shadcn.com/)
- [Tailwind CSS](https://tailwindcss.com)


Added a parallel test runner at run-all.sh and gitignored its output folder in .gitignore.

The script builds voice-filter-file-test once, finds every .wav under audio-tests, runs them concurrently, and writes:

filtered audio to *.filtered.wav
per-file logs to *.log
By default it uses:

--noise-suppression
--suppression-level high
--experimental-aggressive-mode
--dereverb-mode off
--debug-diag
Use it like this:

```
./audio-tests/run-all.sh
```

Useful variants:

```
./audio-tests/run-all.sh --jobs 4
./audio-tests/run-all.sh --out-dir audio-tests/.outputs-alt
./audio-tests/run-all.sh -- --mix 1.0 --attenuation-limit-db 60
```

To turn the current metrics into a repeatable regression check, the repo now includes
`audio-tests/baseline.json` and a wrapper that asserts the analyzed values stay within
configured min/max thresholds:

```
./audio-tests/test.sh
```

You can also run the assertion step directly:

```
./audio-tests/analyze.py --assert-baseline
```
