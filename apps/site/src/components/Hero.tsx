export default function Hero() {
  return (
    <section className="flex flex-col items-center justify-center min-h-screen px-6 text-center gap-8">
      <img
        src={`${import.meta.env.BASE_URL}logo.png`}
        alt="Ripcord"
        className="w-32 h-auto opacity-90"
      />
      <div className="flex flex-col gap-4">
        <h1 className="text-6xl font-extrabold tracking-tight uppercase">Ripcord</h1>
        <p className="text-xl text-gray-400 max-w-xl">
          Voice, text, and screen share — self-hosted on your own hardware.
          No subscriptions. No third parties. Your server, your data.
        </p>
      </div>
      <div className="flex gap-4 flex-wrap justify-center">
        <a
          href="#getting-started"
          className="px-6 py-3 rounded-lg bg-white text-gray-950 font-semibold hover:bg-gray-200 transition-colors"
        >
          Get started
        </a>
        <a
          href="https://github.com/jonocairns/ripcord"
          className="px-6 py-3 rounded-lg border border-gray-700 text-gray-300 font-semibold hover:border-gray-500 hover:text-white transition-colors"
        >
          View on GitHub
        </a>
      </div>
      <p className="text-sm text-gray-600">Open source · MIT license · v{VITE_APP_VERSION}</p>
    </section>
  );
}
