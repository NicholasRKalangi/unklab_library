const donateButton = document.getElementById('donate-book');

async function readResponse(response) {
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error('The server returned an invalid response. Check that server.js is running.'); }
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status}).`);
    return data;
}

document.addEventListener('alpine:init', () => {
    Alpine.data('bookSearch', () => ({
        search: '',
        books: [],
        error: '',
        formatDate(value) {
            if (!value) return 'Unknown';
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return 'Unknown';
            return date.toLocaleDateString(undefined, {
                weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
            });
        },
        async findBooks() {
            try {
                const response = await fetch(`/api/books?search=${encodeURIComponent(this.search.trim())}`);
                this.books = await readResponse(response);
                this.error = '';
            } catch (e) {
                this.books = [];
                this.error = e.message;
            }
        }
    }));
});

async function donateBook() {
    const title = document.getElementById('bookTitle').value.trim();
    const author = document.getElementById('bookAuthor').value.trim();
    const status = document.getElementById('bookStatus').value.trim();
    const bookDescription = document.getElementById('bookDescription').value.trim();
    if (!title || !author || !status || !bookDescription) {
        alert('Please fill in the title, author, status/room, and book description.');
        return;
    }
    donateButton.disabled = true;
    try {
        const response = await fetch('/api/donations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, author, status, bookDescription })
        });
        const result = await readResponse(response);
        alert(result.message || 'Donation submitted. Staff will review your book.');
        document.getElementById('bookTitle').value = '';
        document.getElementById('bookAuthor').value = '';
        document.getElementById('bookStatus').value = '';
        document.getElementById('bookDescription').value = '';
    } catch (error) {
        alert(`Could not submit donation: ${error.message}`);
    } finally {
        donateButton.disabled = false;
    }
}

donateButton.addEventListener('click', donateBook);
