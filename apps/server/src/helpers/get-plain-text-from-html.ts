const getPlainTextFromHtml = (html: string): string => {
	// Strip tags repeatedly until the string stabilises. A single pass is
	// insufficient because overlapping tags (e.g. `<<script>script>`) can
	// reconstruct a valid tag once the inner match is removed.
	let previous: string;
	let current = html;
	do {
		previous = current;
		current = current.replace(/<[^>]+>/g, '');
	} while (current !== previous);
	return current.trim();
};

export { getPlainTextFromHtml };
