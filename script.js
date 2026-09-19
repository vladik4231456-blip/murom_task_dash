// 1. Сначала находим элементы на странице
const newNoteInput = document.querySelector(".new_note_input");
const newNoteButton = document.querySelector(".new_note_button");
const noteList = document.querySelector('.note_list');

newNoteButton.addEventListener('click', () => {
    const noteText = newNoteInput.value;

    if (noteText.trim() === '') return;

    // 1. Создаем блок заметки
    const newNoteItem = document.createElement('div');
    newNoteItem.classList.add('note-item');

    // 2. Наполняем его разметкой
    newNoteItem.innerHTML = `
        <label>
            <input type="checkbox">
            <span>${noteText}</span>
        </label>
        <button type="button" class="delete_note">Delete</button>
    `;

    // 3. Находим кнопку "Delete", которая НАХОДИТСЯ ВНУТРИ newNoteItem
    const deleteButton = newNoteItem.querySelector('.delete_note');

    // 4. Вешаем на нее удаление ВСЕЙ карточки newNoteItem
    deleteButton.addEventListener('click', () => {
        newNoteItem.remove();
    });

    // 5. Добавляем карточку в общий список на странице
    noteList.append(newNoteItem);

    // 6. Очищаем инпут
    newNoteInput.value = '';
});