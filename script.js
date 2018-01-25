;(function() {
    window.onload = function() {
        console.log('asd')
        setTimeout(function() {
            document.querySelector('.background').className += ' show'
        }, 500)
        setTimeout(function() {
            document.querySelector('.title').className += ' show'
        }, 1000)
    }
})(this)