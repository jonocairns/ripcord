const steps = [
  {
    step: '01',
    title: 'Pull and run the image',
    code: 'docker run -d \\\n  -v /root/.config/sharkord:/root/.config/sharkord \\\n  -e PORT=4991 -e WEBRTC_PORT=40000 \\\n  ghcr.io/jonocairns/ripcord:latest',
  },
  {
    step: '02',
    title: 'Open port 40000',
    description: 'Expose port 40000 on both UDP and TCP in your firewall or security group for WebRTC media traffic.',
  },
  {
    step: '03',
    title: 'Reverse proxy',
    description: 'Point nginx or Caddy at port 4991. Add a TLS certificate and set your public hostname in config.',
  },
  {
    step: '04',
    title: 'Download the desktop client',
    description: 'Grab the latest release from GitHub, connect to your server, and you\'re done.',
    link: { label: 'Download client →', href: 'https://github.com/jonocairns/ripcord/releases' },
  },
];

export default function GettingStarted() {
  return (
    <section id="getting-started" className="px-6 py-24 bg-gray-900">
      <div className="max-w-3xl mx-auto flex flex-col gap-12">
        <h2 className="text-3xl font-bold text-center">Up in minutes</h2>
        <div className="flex flex-col gap-8">
          {steps.map((s) => (
            <div key={s.step} className="flex gap-6">
              <span className="text-2xl font-mono font-bold text-gray-700 shrink-0 w-10">
                {s.step}
              </span>
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold text-lg">{s.title}</h3>
                {'code' in s && (
                  <code className="block bg-gray-950 border border-gray-800 rounded-lg px-4 py-3 text-sm text-green-400 font-mono whitespace-pre">
                    {s.code}
                  </code>
                )}
                {'description' in s && (
                  <p className="text-gray-400 text-sm leading-relaxed">{s.description}</p>
                )}
                {'link' in s && s.link && (
                  <a
                    href={s.link.href}
                    className="text-sm text-white underline hover:text-gray-300 transition-colors"
                  >
                    {s.link.label}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
