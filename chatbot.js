const promptInput = document.getElementById("prompt-input")
const sendBtn = document.getElementById("send-btn")
const chatDiv = document.querySelector(".chat-div")


function addMessage(message, sender) {

    const messageDiv = document.createElement("div")

    messageDiv.classList.add("message")

    if (sender === "user") {
        messageDiv.classList.add("user-message")
    } else {
        messageDiv.classList.add("bot-message")
    }

    messageDiv.textContent = message

    chatDiv.appendChild(messageDiv)

    chatDiv.scrollTop = chatDiv.scrollHeight
}


async function sendMessage() {

    const question = promptInput.value.trim()

    if (question === "") {
        return
    }

    // Display user's message
    addMessage(question, "user")

    // Clear input
    promptInput.value = ""

    // Disable button while waiting
    sendBtn.disabled = true

    try {

        const response = await fetch("/api/chat", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                question: question
            })

        })


        const data = await response.json()


        if (!response.ok) {

            addMessage(
                data.error || "Something went wrong.",
                "bot"
            )

            return
        }


        // Display AI response
        addMessage(data.answer, "bot")

    }

    catch (error) {

        console.error(error)

        addMessage(
            "Could not connect to the AI chatbot.",
            "bot"
        )

    }

    finally {

        sendBtn.disabled = false

        promptInput.focus()

    }
}


sendBtn.addEventListener("click", sendMessage)


promptInput.addEventListener("keydown", function(event) {

    if (event.key === "Enter") {
        sendMessage()
    }

})